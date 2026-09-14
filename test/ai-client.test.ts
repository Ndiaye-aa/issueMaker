import { jest } from '@jest/globals';
import { z } from 'zod';
import { ResilientAIClient } from '../src/ai/client.js';
import { RateLimitError } from '../src/ai/provider.js';
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
