import { jest } from '@jest/globals';
import { z } from 'zod';
import { ResilientAIClient } from '../src/ai/client.js';
import { RateLimitError, TransientError } from '../src/ai/provider.js';
import type { AIProvider, CompletionRequest } from '../src/ai/provider.js';

const schema = z.object({ value: z.number() });

function makeRequest(): CompletionRequest {
  return { systemPrompt: 'system', userPrompt: 'user' };
}

class FakeProvider implements AIProvider {
  readonly name: string;
  private callIndex = 0;

  constructor(
    name: string,
    private readonly responses: Array<unknown | Error>,
  ) {
    this.name = name;
  }

  get calls(): number {
    return this.callIndex;
  }

  async complete(): Promise<unknown> {
    const response = this.responses[this.callIndex];
    this.callIndex += 1;
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

describe('ResilientAIClient', () => {
  it('retorna com sucesso na primeira tentativa do provedor principal', async () => {
    const primary = new FakeProvider('primary', [{ value: 42 }]);
    const fallback = new FakeProvider('fallback', []);
    const client = new ResilientAIClient(primary, fallback);

    const result = await client.complete(makeRequest(), schema);

    expect(result).toEqual({ value: 42 });
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it('faz retry no mesmo provedor quando a saída falha na validação de schema', async () => {
    const primary = new FakeProvider('primary', [{ value: 'not-a-number' }, { value: 42 }]);
    const fallback = new FakeProvider('fallback', []);
    const client = new ResilientAIClient(primary, fallback);

    const result = await client.complete(makeRequest(), schema);

    expect(result).toEqual({ value: 42 });
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(0);
  });

  it('aciona o fallback após esgotar as tentativas de rate-limit no provedor principal', async () => {
    const primary = new FakeProvider('primary', [
      new RateLimitError(),
      new RateLimitError(),
    ]);
    const fallback = new FakeProvider('fallback', [{ value: 7 }]);
    const client = new ResilientAIClient(primary, fallback, 3, 2, silentLog);

    const result = await client.complete(makeRequest(), schema);

    expect(result).toEqual({ value: 7 });
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(1);
  });

  it('propaga o erro quando ambos os provedores falham totalmente', async () => {
    const primary = new FakeProvider('primary', [new RateLimitError(), new RateLimitError()]);
    const fallback = new FakeProvider('fallback', [new RateLimitError(), new RateLimitError()]);
    const client = new ResilientAIClient(primary, fallback, 3, 2, silentLog);

    await expect(client.complete(makeRequest(), schema)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('cai no fallback imediatamente quando o retry-after do provedor principal é longo demais', async () => {
    const primary = new FakeProvider('primary', [
      new RateLimitError('rate limit', 715_000),
    ]);
    const fallback = new FakeProvider('fallback', [{ value: 9 }]);
    const client = new ResilientAIClient(primary, fallback, 3, 2, silentLog);

    const start = Date.now();
    const result = await client.complete(makeRequest(), schema);

    expect(result).toEqual({ value: 9 });
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('depois de cair no fallback, roteia as chamadas seguintes direto para ele e avisa uma única vez', async () => {
    const primary = new FakeProvider('primary', [
      new RateLimitError('rate limit', 715_000),
      { value: 1 },
    ]);
    const fallback = new FakeProvider('fallback', [{ value: 1 }, { value: 2 }]);
    const log = jest.fn();
    const client = new ResilientAIClient(primary, fallback, 3, 2, log);

    await expect(client.complete(makeRequest(), schema)).resolves.toEqual({ value: 1 });
    await expect(client.complete(makeRequest(), schema)).resolves.toEqual({ value: 2 });

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/primary sem cota \(retry-after 715s\).*fallback/);
  });

  it('insiste no provedor principal enquanto o retry-after curto couber no orçamento de espera', async () => {
    const primary = new FakeProvider('primary', [
      new RateLimitError('throttle', 10),
      new RateLimitError('throttle', 10),
      new RateLimitError('throttle', 10),
      { value: 3 },
    ]);
    const fallback = new FakeProvider('fallback', []);
    const log = jest.fn();
    const client = new ResilientAIClient(primary, fallback, 3, 8, log);

    await expect(client.complete(makeRequest(), schema)).resolves.toEqual({ value: 3 });

    expect(primary.calls).toBe(4);
    expect(fallback.calls).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('esgotar as tentativas de rate-limit também fixa o fallback para as chamadas seguintes', async () => {
    const primary = new FakeProvider('primary', [new RateLimitError(), new RateLimitError()]);
    const fallback = new FakeProvider('fallback', [{ value: 1 }, { value: 2 }]);
    const client = new ResilientAIClient(primary, fallback, 3, 2, silentLog);

    await client.complete(makeRequest(), schema);
    await client.complete(makeRequest(), schema);

    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(2);
  });

  it('erro que não é rate-limit no provedor principal propaga sem fixar o fallback', async () => {
    const primary = new FakeProvider('primary', [
      new Error('boom'),
      new Error('boom'),
      new Error('boom'),
      { value: 5 },
    ]);
    const fallback = new FakeProvider('fallback', []);
    const log = jest.fn();
    const client = new ResilientAIClient(primary, fallback, 3, 2, log);

    await expect(client.complete(makeRequest(), schema)).rejects.toThrow('boom');
    await expect(client.complete(makeRequest(), schema)).resolves.toEqual({ value: 5 });

    expect(fallback.calls).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });
});

const silentLog = (): void => {};

describe('ResilientAIClient — erros transitórios e concorrência', () => {
  it('repete o mesmo prompt em erro transitório, sem anexar dica de schema', async () => {
    const seen: string[] = [];
    const primary: AIProvider = {
      name: 'primary',
      async complete(request: CompletionRequest) {
        seen.push(request.userPrompt);
        if (seen.length === 1) throw new TransientError('loop de repetição');
        if (seen.length === 2) throw Object.assign(new Error('Internal'), { status: 502 });
        return { value: 1 };
      },
    };
    const client = new ResilientAIClient(primary, new FakeProvider('fallback', []), 3, 2, silentLog);

    await expect(client.complete(makeRequest(), schema)).resolves.toEqual({ value: 1 });
    expect(seen).toEqual(['user', 'user', 'user']);
  });

  it('anexa a dica de correção quando a resposta falha no schema', async () => {
    const seen: string[] = [];
    const primary: AIProvider = {
      name: 'primary',
      async complete(request: CompletionRequest) {
        seen.push(request.userPrompt);
        return seen.length === 1 ? { value: 'x' } : { value: 1 };
      },
    };
    const client = new ResilientAIClient(primary, new FakeProvider('fallback', []), 3, 2, silentLog);

    await client.complete(makeRequest(), schema);
    expect(seen[0]).toBe('user');
    expect(seen[1]).toMatch(/falhou nesta validação/);
  });

  it('limita chamadas simultâneas no principal e serializa no fallback', async () => {
    const gauge = () => {
      let active = 0;
      let peak = 0;
      return {
        get peak() {
          return peak;
        },
        async run<T>(result: T): Promise<T> {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return result;
        },
      };
    };
    const primaryGauge = gauge();
    const fallbackGauge = gauge();
    let primaryCalls = 0;
    const primary: AIProvider = {
      name: 'primary',
      async complete() {
        primaryCalls += 1;
        if (primaryCalls > 6) throw new RateLimitError('cota', 999_000);
        return primaryGauge.run({ value: 1 });
      },
    };
    const fallback: AIProvider = {
      name: 'fallback',
      complete: () => fallbackGauge.run({ value: 2 }),
    };
    const client = new ResilientAIClient(primary, fallback, 3, 2, silentLog, { primary: 2, fallback: 1 });

    const first = await Promise.all(Array.from({ length: 6 }, () => client.complete(makeRequest(), schema)));
    const second = await Promise.all(Array.from({ length: 4 }, () => client.complete(makeRequest(), schema)));

    expect(first.every((r) => r.value === 1)).toBe(true);
    expect(second.every((r) => r.value === 2)).toBe(true);
    expect(primaryGauge.peak).toBe(2);
    expect(fallbackGauge.peak).toBe(1);
  });
});

describe('ResilientAIClient — sem fallback', () => {
  it('propaga o rate limit quando não há fallback configurado', async () => {
    const primary = new FakeProvider('primary', [new RateLimitError('cota', 999_000)]);
    const log = jest.fn();
    const client = new ResilientAIClient(primary, undefined, 3, 2, log);

    await expect(client.complete(makeRequest(), schema)).rejects.toBeInstanceOf(RateLimitError);
    expect(primary.calls).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('continua usando o principal nas chamadas seguintes após um rate limit sem fallback', async () => {
    const primary = new FakeProvider('primary', [new RateLimitError('cota', 999_000), { value: 4 }]);
    const client = new ResilientAIClient(primary, undefined, 3, 2, silentLog);

    await expect(client.complete(makeRequest(), schema)).rejects.toBeInstanceOf(RateLimitError);
    await expect(client.complete(makeRequest(), schema)).resolves.toEqual({ value: 4 });
  });
});

describe('ResilientAIClient — usageReport', () => {
  class MeteredProvider extends FakeProvider {
    usage = {
      calls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      thinkingTokens: 0,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 0,
      costUsd: 0.5,
    };
  }

  it('lista uma linha por provedor com uso registrado, e nada para quem não mediu ou não chamou', () => {
    const primary = new MeteredProvider('claude-code', []);
    const fallback = new FakeProvider('ollama', []);
    const client = new ResilientAIClient(primary, fallback);

    expect(client.usageReport()).toEqual([
      expect.stringMatching(/^uso de IA: claude-code — 1 chamada\(s\) · entrada 1,0k.*saída 200.*US\$ 0,50$/),
    ]);
  });

  it('sem chamadas nenhum provedor, o relatório fica vazio', () => {
    const primary = new MeteredProvider('claude-code', []);
    primary.usage = { ...primary.usage, calls: 0 };
    const client = new ResilientAIClient(primary, undefined);
    expect(client.usageReport()).toEqual([]);
  });
});
