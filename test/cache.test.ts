import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CachedAIClient } from '../src/ai/cache.js';
import type { AIClient, AIProvider, CompletionRequest } from '../src/ai/provider.js';

const schema = z.object({ value: z.number() });
const request: CompletionRequest = { systemPrompt: 'sys', userPrompt: 'user' };

function fakeInner(responses: unknown[]): AIClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete<T>() {
      const response = responses[calls];
      calls += 1;
      return response as T;
    },
  };
}

function fakeProvider(name: string): AIProvider {
  return { name, complete: async () => ({}) };
}

/**
 * Simula um `ResilientAIClient`: cada resposta pode ter sido "servida" por um provedor
 * diferente do esperado, como acontece quando o primário estoura cota no meio de uma
 * chamada e ela acaba caindo no fallback.
 */
function fakeProviderAwareInner(
  entries: Array<{ response: unknown; provider: AIProvider; expected?: AIProvider }>,
): AIClient & { calls: number; expectedProviderSignature(): string; completeWithProvider<T>(): Promise<{ result: T; provider: AIProvider }> } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    expectedProviderSignature() {
      return (entries[calls]?.expected ?? entries[calls]?.provider ?? entries[0]!.provider).name;
    },
    async complete<T>() {
      const entry = entries[calls]!;
      calls += 1;
      return entry.response as T;
    },
    async completeWithProvider<T>() {
      const entry = entries[calls]!;
      calls += 1;
      return { result: entry.response as T, provider: entry.provider };
    },
  };
}

describe('CachedAIClient', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sdd-bot-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('só chama o cliente interno uma vez para o mesmo prompt + schema', async () => {
    const inner = fakeInner([{ value: 1 }, { value: 2 }]);
    const client = new CachedAIClient(inner, dir, 'sig');

    expect(await client.complete(request, schema)).toEqual({ value: 1 });
    expect(await client.complete(request, schema)).toEqual({ value: 1 });
    expect(inner.calls).toBe(1);
    expect(client.stats).toEqual({ hits: 1, misses: 1 });
  });

  it('entradas são compartilhadas entre instâncias com a mesma assinatura', async () => {
    await new CachedAIClient(fakeInner([{ value: 7 }]), dir, 'sig').complete(request, schema);
    const inner = fakeInner([{ value: 99 }]);
    expect(await new CachedAIClient(inner, dir, 'sig').complete(request, schema)).toEqual({ value: 7 });
    expect(inner.calls).toBe(0);
  });

  it('prompt, schema ou assinatura diferentes geram chaves diferentes', async () => {
    const inner = fakeInner([{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }]);
    const client = new CachedAIClient(inner, dir, 'sig');
    await client.complete(request, schema);
    await client.complete({ ...request, userPrompt: 'outro' }, schema);
    await client.complete(request, z.object({ value: z.number().int() }));
    await new CachedAIClient(inner, dir, 'outra-sig').complete(request, schema);
    expect(inner.calls).toBe(4);
    expect((await readdir(dir)).length).toBeGreaterThan(0);
  });

  it('ignora entrada em cache que não passa mais no schema', async () => {
    await new CachedAIClient(fakeInner(['texto' as unknown]), dir, 'sig').complete(request, z.string());
    // Mesmo prompt e assinatura, mas o schema agora exige um objeto — a chave muda e,
    // ainda que não mudasse, a validação na leitura descartaria a entrada.
    const inner = fakeInner([{ value: 5 }]);
    expect(await new CachedAIClient(inner, dir, 'sig').complete(request, schema)).toEqual({ value: 5 });
    expect(inner.calls).toBe(1);
  });

  it('não grava nada quando o cliente interno falha', async () => {
    const inner: AIClient = {
      async complete() {
        throw new Error('boom');
      },
    };
    await expect(new CachedAIClient(inner, dir, 'sig').complete(request, schema)).rejects.toThrow('boom');
    expect(await readdir(dir)).toEqual([]);
  });

  it('usageReport soma hits/misses às linhas do cliente interno, se houver', async () => {
    const inner = fakeInner([{ value: 1 }, { value: 2 }]);
    const client = new CachedAIClient(inner, dir, 'sig');
    expect(client.usageReport()).toEqual([]);

    await client.complete(request, schema);
    await client.complete(request, schema);
    await client.complete({ ...request, userPrompt: 'outro' }, schema);

    expect(client.usageReport()).toEqual(['cache em disco: 1 hit(s) / 2 miss(es)']);
  });

  it('usageReport inclui as linhas do cliente interno quando ele tem usageReport', async () => {
    const inner = {
      ...fakeInner([{ value: 1 }]),
      usageReport: () => ['uso de IA: claude-code — 1 chamada(s)'],
    };
    const client = new CachedAIClient(inner, dir, 'sig');
    await client.complete(request, schema);

    expect(client.usageReport()).toEqual([
      'uso de IA: claude-code — 1 chamada(s)',
      'cache em disco: 0 hit(s) / 1 miss(es)',
    ]);
  });

  describe('assinatura por provedor (inner "provider-aware")', () => {
    const primary = fakeProvider('primary');
    const fallback = fakeProvider('fallback');

    it('grava a resposta sob a assinatura do provedor que realmente respondeu, não a esperada', async () => {
      // Assinatura estática do construtor diz "sig" (equivalente ao primário no client-factory),
      // mas quem responde de fato é o fallback — como quando o primário estoura cota no meio
      // desta mesma chamada.
      const inner = fakeProviderAwareInner([{ response: { value: 1 }, provider: fallback }]);
      const client = new CachedAIClient(inner, dir, primary.name);

      await client.complete(request, schema);
      expect(inner.calls).toBe(1);

      // Uma nova instância que já sabe, de antemão, que o fallback está ativo (assinatura
      // esperada = fallback) deve achar a entrada gravada acima — prova que foi gravada sob
      // "fallback", não sob "primary" (a assinatura estática/otimista).
      const readBack = fakeProviderAwareInner([{ response: { value: 999 }, provider: fallback }]);
      const client2 = new CachedAIClient(readBack, dir, primary.name);
      const result = await client2.complete(request, schema);

      expect(result).toEqual({ value: 1 });
      expect(readBack.calls).toBe(0);
    });

    it('não reaproveita, sob o primário, uma resposta que veio do fallback', async () => {
      const inner = fakeProviderAwareInner([{ response: { value: 1 }, provider: fallback }]);
      await new CachedAIClient(inner, dir, primary.name).complete(request, schema);

      // Nova chamada com o primário saudável de novo (expectedProviderSignature = "primary"):
      // não deve reaproveitar a resposta do fallback gravada antes.
      const freshInner = fakeProviderAwareInner([{ response: { value: 2 }, provider: primary }]);
      const client = new CachedAIClient(freshInner, dir, primary.name);
      const result = await client.complete(request, schema);

      expect(result).toEqual({ value: 2 });
      expect(freshInner.calls).toBe(1);
    });

    it('sem suporte a completeWithProvider, cai no comportamento estático de hoje', async () => {
      const inner = fakeInner([{ value: 5 }]);
      const client = new CachedAIClient(inner, dir, 'sig');

      expect(await client.complete(request, schema)).toEqual({ value: 5 });
      expect(await client.complete(request, schema)).toEqual({ value: 5 });
      expect(inner.calls).toBe(1);
    });
  });
});
