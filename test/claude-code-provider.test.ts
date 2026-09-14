import { jest } from '@jest/globals';
import { z } from 'zod';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeCodeProvider,
  classifyFailure,
  toOutputSchema,
  type QueryRunner,
} from '../src/ai/providers/claude-code.js';
import { RateLimitError, TransientError } from '../src/ai/provider.js';

const objectSchema = z.object({ same: z.boolean() });
const arraySchema = z.array(z.object({ id: z.string() }));
const request = { systemPrompt: 'sys', userPrompt: 'user', temperature: 0.1 };

function resultMessage(overrides: Partial<SDKResultMessage>): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {} as SDKResultMessage['usage'],
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 's',
    ...overrides,
  } as SDKResultMessage;
}

function runnerYielding(...messages: SDKMessage[]): jest.Mock<QueryRunner> {
  return jest.fn<QueryRunner>(async function* () {
    for (const message of messages) yield message;
  });
}

function sentOptions(runner: jest.Mock<QueryRunner>) {
  return runner.mock.calls[0]?.[0]?.options ?? {};
}

describe('ClaudeCodeProvider', () => {
  it('envia prompt/system/modelo sem ferramentas nem settings e devolve structured_output', async () => {
    const runner = runnerYielding(
      { type: 'system', subtype: 'init' } as unknown as SDKMessage,
      resultMessage({ structured_output: { same: true } }),
    );
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-5', runQuery: runner });

    const result = await provider.complete(request, objectSchema);

    expect(result).toEqual({ same: true });
    expect(runner.mock.calls[0]?.[0]?.prompt).toBe('user');
    const options = sentOptions(runner);
    expect(options).toMatchObject({
      model: 'claude-sonnet-5',
      systemPrompt: 'sys',
      tools: [],
      maxTurns: 3,
      settingSources: [],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(options.env).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    expect(options).toMatchObject({ effort: 'low', thinking: { type: 'disabled' } });
    expect(provider.usage).toEqual({
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.01,
    });
  });

  it('acumula tokens de modelUsage (entrada, saída, raciocínio, cache) em várias chamadas', async () => {
    const runner = runnerYielding(
      resultMessage({
        structured_output: { same: true },
        modelUsage: {
          'claude-sonnet-5': {
            inputTokens: 100,
            outputTokens: 40,
            thinkingTokens: 10,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 200_000,
            maxOutputTokens: 8_000,
          },
        } as unknown as SDKResultMessage['modelUsage'],
      }),
    );
    const provider = new ClaudeCodeProvider({ runQuery: runner });
    await provider.complete(request, objectSchema);
    await provider.complete(request, objectSchema);

    expect(provider.usage).toMatchObject({
      calls: 2,
      inputTokens: 200,
      outputTokens: 80,
      thinkingTokens: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 10,
    });
  });

  it('sem modelUsage, cai para o usage bruto do SDK', async () => {
    const runner = runnerYielding(
      resultMessage({
        structured_output: { same: true },
        modelUsage: {},
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 1,
        } as unknown as SDKResultMessage['usage'],
      }),
    );
    const provider = new ClaudeCodeProvider({ runQuery: runner });
    await provider.complete(request, objectSchema);

    expect(provider.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 1,
    });
  });

  it('usa o modelo leve quando o pedido é tier "light"', async () => {
    const runner = runnerYielding(resultMessage({ structured_output: { same: true } }));
    const provider = new ClaudeCodeProvider({ model: 'claude-sonnet-5', runQuery: runner });

    await provider.complete({ ...request, tier: 'light' }, objectSchema);

    expect(sentOptions(runner).model).toBe(provider.lightModel);
  });

  it('respeita effort/thinking configurados', async () => {
    const runner = runnerYielding(resultMessage({ structured_output: { same: true } }));
    const provider = new ClaudeCodeProvider({ effort: 'high', thinking: 'adaptive', runQuery: runner });

    await provider.complete(request, objectSchema);

    expect(sentOptions(runner)).toMatchObject({ effort: 'high', thinking: { type: 'adaptive' } });
  });

  it('usa claude-sonnet-5 como modelo padrão', () => {
    expect(new ClaudeCodeProvider().model).toBe('claude-sonnet-5');
  });

  it('embrulha schemas de array em { items } e desembrulha a resposta', async () => {
    const runner = runnerYielding(resultMessage({ structured_output: { items: [{ id: 'REQ-1' }] } }));
    const provider = new ClaudeCodeProvider({ runQuery: runner });

    const result = await provider.complete(request, arraySchema);

    expect(result).toEqual([{ id: 'REQ-1' }]);
    const schema = sentOptions(runner).outputFormat?.schema as Record<string, unknown>;
    expect(schema).toMatchObject({ type: 'object', required: ['items'], additionalProperties: false });
    expect((schema.properties as { items: { type: string } }).items.type).toBe('array');
    expect(schema.$schema).toBeUndefined();
  });

  it('erra (retry de schema) quando o resultado é success sem structured_output', async () => {
    const provider = new ClaudeCodeProvider({ runQuery: runnerYielding(resultMessage({})) });
    await expect(provider.complete(request, objectSchema)).rejects.toThrow(/sem structured_output/);
  });

  it('erra (retry de schema) em error_max_structured_output_retries', async () => {
    const provider = new ClaudeCodeProvider({
      runQuery: runnerYielding(
        resultMessage({ subtype: 'error_max_structured_output_retries', errors: ['x'] } as Partial<SDKResultMessage>),
      ),
    });
    const err = await provider.complete(request, objectSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(String(err)).toMatch(/JSON válido/);
  });

  it('mapeia limite de uso para RateLimitError (aciona o fallback)', async () => {
    const provider = new ClaudeCodeProvider({
      runQuery: runnerYielding(
        resultMessage({ is_error: true, result: "You've hit your usage limit. Resets at 3pm" }),
      ),
    });
    await expect(provider.complete(request, objectSchema)).rejects.toBeInstanceOf(RateLimitError);

    const byReason = new ClaudeCodeProvider({
      runQuery: runnerYielding(
        resultMessage({ subtype: 'error_during_execution', errors: ['x'], terminal_reason: 'blocking_limit' } as Partial<SDKResultMessage>),
      ),
    });
    await expect(byReason.complete(request, objectSchema)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('falha de processo vira TransientError (reenvia o mesmo prompt)', async () => {
    const runner = jest.fn<QueryRunner>(async function* () {
      throw new Error('Claude Code process exited with code 1. stderr: boom');
      yield undefined as never;
    });
    const provider = new ClaudeCodeProvider({ runQuery: runner });
    await expect(provider.complete(request, objectSchema)).rejects.toBeInstanceOf(TransientError);
  });

  it('aborta por timeout e reporta como TransientError', async () => {
    const runner = jest.fn<QueryRunner>(async function* ({ options }) {
      await new Promise<void>((_resolve, reject) => {
        options?.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      yield undefined as never;
    });
    const provider = new ClaudeCodeProvider({ runQuery: runner, timeoutMs: 20 });
    await expect(provider.complete(request, objectSchema)).rejects.toThrow(/não respondeu em/);
  });

  it('erro de credenciais vem com dica de login e não é transitório', async () => {
    const provider = new ClaudeCodeProvider({
      runQuery: runnerYielding(resultMessage({ is_error: true, result: 'Not logged in' })),
    });
    const err = await provider.complete(request, objectSchema).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(String(err)).toMatch(/\/login|ANTHROPIC_API_KEY/);
  });
});

describe('toOutputSchema / classifyFailure', () => {
  it('mantém objetos na raiz sem embrulhar', () => {
    const { jsonSchema, wrapped } = toOutputSchema(objectSchema);
    expect(wrapped).toBe(false);
    expect(jsonSchema.type).toBe('object');
  });

  it('classifica mensagens', () => {
    expect(classifyFailure('429 Too Many Requests')).toBeInstanceOf(RateLimitError);
    expect(classifyFailure('Invalid API key')).not.toBeInstanceOf(TransientError);
    expect(classifyFailure('Failed to spawn Claude Code process')).toBeInstanceOf(TransientError);
  });
});
