import { z } from 'zod';
import { OpenAICompatibleProvider } from '../src/ai/providers/openai-compatible.js';
import { RateLimitError } from '../src/ai/provider.js';

const schema = z.object({ same: z.boolean() });
const request = { systemPrompt: 'sys', userPrompt: 'user' };

function providerWith(create: (params: unknown) => Promise<unknown>): OpenAICompatibleProvider {
  const provider = new OpenAICompatibleProvider({
    name: 'openai',
    apiKey: 'k',
    baseURL: 'https://example.test/v1',
    model: 'm',
  });
  (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };
  return provider;
}

describe('OpenAICompatibleProvider', () => {
  it('chama chat.completions com modelo, temperatura e mensagens, e faz parse do JSON', async () => {
    const calls: unknown[] = [];
    const provider = providerWith(async (params) => {
      calls.push(params);
      return { choices: [{ finish_reason: 'stop', message: { content: '```json\n{"same":true}\n```' } }] };
    });

    await expect(provider.complete(request, schema)).resolves.toEqual({ same: true });
    expect(calls[0]).toMatchObject({
      model: 'm',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
      ],
    });
    expect(provider.name).toBe('openai');
  });

  it('converte HTTP 429 em RateLimitError com retry-after em ms', async () => {
    const provider = providerWith(async () => {
      throw Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '7' } });
    });
    const err = await provider.complete(request, schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(7000);
  });

  it('lê retry-after também de um objeto Headers', async () => {
    const provider = providerWith(async () => {
      throw Object.assign(new Error('rate'), { status: 429, headers: new Headers({ 'retry-after': '2' }) });
    });
    const err = await provider.complete(request, schema).catch((e: unknown) => e);
    expect((err as RateLimitError).retryAfterMs).toBe(2000);
  });

  it('erra quando a resposta foi cortada por limite de tokens ou veio vazia', async () => {
    const cut = providerWith(async () => ({ choices: [{ finish_reason: 'length', message: { content: '[' } }] }));
    await expect(cut.complete(request, schema)).rejects.toThrow(/limite de tokens/);

    const empty = providerWith(async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }));
    await expect(empty.complete(request, schema)).rejects.toThrow(/resposta vazia do provedor openai/);
  });
});
