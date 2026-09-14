import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CachedAIClient } from '../src/ai/cache.js';
import type { AIClient, CompletionRequest } from '../src/ai/provider.js';

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
});
