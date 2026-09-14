import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  Options,
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AIProvider, CompletionRequest, ProviderUsage } from '../provider.js';
import { RateLimitError, TransientError, addUsage, emptyUsage } from '../provider.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
/** Modelo das tarefas `tier: 'light'` (decisões sim/não): mais barato e mais rápido. */
export const DEFAULT_CLAUDE_LIGHT_MODEL = 'claude-haiku-4-5-20251001';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const THINKING_MODES = ['disabled', 'adaptive'] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];
/**
 * Todas as chamadas são formatação de saída estruturada a partir de um prompt já detalhado;
 * raciocínio estendido só gera tokens de saída invisíveis e mais lentos.
 */
export const DEFAULT_EFFORT: EffortLevel = 'low';
export const DEFAULT_THINKING: ThinkingMode = 'disabled';
const DEFAULT_TIMEOUT_MS = 600_000;
/** Sem ferramentas, turnos extras só servem para a saída estruturada (e sua retentativa interna). */
export const MAX_TURNS = 3;

/** Assinatura mínima de `query` do Agent SDK, injetável nos testes. */
export type QueryRunner = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeProviderOptions {
  model?: string;
  lightModel?: string;
  effort?: EffortLevel;
  thinking?: ThinkingMode;
  timeoutMs?: number;
  runQuery?: QueryRunner;
}

const RATE_LIMIT_PATTERN = /rate limit|usage limit|limit reached|overloaded|too many requests|\b429\b/i;
const AUTH_PATTERN = /not logged in|invalid api key|authentication|unauthorized|\b401\b/i;
const RATE_LIMIT_TERMINAL_REASONS = new Set(['blocking_limit', 'rapid_refill_breaker']);

/**
 * Claude pela própria máquina: o Agent SDK embute o binário do Claude Code e o roda como
 * subprocesso local. Sem ANTHROPIC_API_KEY no ambiente, ele usa o login do Claude Code já
 * feito nesta máquina (como o Ollama, não precisa de chave no .env); com a chave definida,
 * ela tem prioridade. Cada chamada é uma sessão nova, sem ferramentas, com resposta validada
 * por JSON Schema pelo próprio SDK.
 */
export class ClaudeCodeProvider implements AIProvider {
  readonly name = 'claude-code';
  readonly model: string;
  readonly lightModel: string;
  readonly effort: EffortLevel;
  readonly thinking: ThinkingMode;
  private readonly timeoutMs: number;
  private readonly runQuery: QueryRunner;
  private readonly usageTotals: ProviderUsage = emptyUsage();

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL;
    this.lightModel = options.lightModel ?? DEFAULT_CLAUDE_LIGHT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    this.thinking = options.thinking ?? DEFAULT_THINKING;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runQuery = options.runQuery ?? query;
  }

  get usage(): ProviderUsage {
    return { ...this.usageTotals };
  }

  modelFor(request: CompletionRequest): string {
    return request.tier === 'light' ? this.lightModel : this.model;
  }

  async complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<unknown> {
    const { jsonSchema, wrapped } = toOutputSchema(schema);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.timeoutMs);

    let result: SDKResultMessage | undefined;
    try {
      const stream = this.runQuery({
        prompt: request.userPrompt,
        options: {
          model: this.modelFor(request),
          systemPrompt: request.systemPrompt,
          effort: this.effort,
          thinking: { type: this.thinking },
          // Só geração de texto: nenhuma ferramenta, nada carregado de CLAUDE.md/settings do
          // usuário ou do projeto. A saída estruturada é uma chamada de ferramenta interna do
          // SDK; se o modelo escrever texto antes dela, precisa de um turno a mais — com
          // maxTurns: 1 isso virava "error_max_turns" em prompts longos (planejamento).
          tools: [],
          maxTurns: MAX_TURNS,
          settingSources: [],
          cwd: tmpdir(),
          outputFormat: { type: 'json_schema', schema: jsonSchema },
          abortController,
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            CLAUDE_AGENT_SDK_CLIENT_APP: 'sdd-bot',
          },
        },
      });
      for await (const message of stream) {
        if (message.type === 'result') {
          result = message;
          break;
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        throw new TransientError(
          `claude-code não respondeu em ${Math.round(this.timeoutMs / 1000)}s; chamada abortada`,
        );
      }
      throw classifyFailure(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }

    if (!result) {
      throw new TransientError('claude-code encerrou sem mensagem de resultado');
    }
    addUsage(this.usageTotals, usageFromResult(result));

    if (result.subtype !== 'success') {
      const detail = [result.subtype, ...(result.errors ?? [])].join(': ');
      if (
        result.subtype === 'error_max_structured_output_retries' ||
        result.subtype === 'error_max_turns'
      ) {
        throw new Error(`claude-code não produziu JSON válido para o schema (${detail})`);
      }
      throw classifyFailure(detail, result.terminal_reason);
    }
    if (result.is_error) {
      throw classifyFailure(result.result, result.terminal_reason);
    }
    if (result.structured_output === undefined || result.structured_output === null) {
      throw new Error('claude-code terminou sem structured_output; resposta não validada');
    }
    return wrapped
      ? (result.structured_output as { items: unknown }).items
      : result.structured_output;
  }
}

/**
 * `modelUsage` é o campo que o SDK recomenda para contabilidade (cobre todas as chamadas do
 * pipeline interno, por modelo); `usage` cobre só o loop principal e fica como reserva.
 */
export function usageFromResult(result: SDKResultMessage): ProviderUsage {
  const totals = emptyUsage();
  totals.calls = 1;
  totals.costUsd = result.total_cost_usd ?? 0;
  const perModel = Object.values(result.modelUsage ?? {});
  if (perModel.length > 0) {
    for (const model of perModel) {
      addUsage(totals, {
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        thinkingTokens: model.thinkingTokens,
        cacheReadInputTokens: model.cacheReadInputTokens,
        cacheCreationInputTokens: model.cacheCreationInputTokens,
      });
    }
    return totals;
  }
  const usage = result.usage ?? {};
  return addUsage(totals, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
  });
}

/**
 * Saída estruturada exige objeto na raiz; schemas de array (extração, backlog) são
 * embrulhados em `{ items: [...] }` e desembrulhados na volta.
 */
export function toOutputSchema(schema: ZodType<unknown>): {
  jsonSchema: Record<string, unknown>;
  wrapped: boolean;
} {
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema, { target: 'draft-7' });
  delete jsonSchema.$schema;
  if (jsonSchema.type === 'array') {
    return {
      wrapped: true,
      jsonSchema: {
        type: 'object',
        properties: { items: jsonSchema },
        required: ['items'],
        additionalProperties: false,
      },
    };
  }
  return { jsonSchema, wrapped: false };
}

export function classifyFailure(message: string, terminalReason?: string): Error {
  if ((terminalReason && RATE_LIMIT_TERMINAL_REASONS.has(terminalReason)) || RATE_LIMIT_PATTERN.test(message)) {
    return new RateLimitError(`claude-code: ${message}`);
  }
  if (AUTH_PATTERN.test(message)) {
    return new Error(
      `claude-code sem credenciais: ${message}. Faça login no Claude Code (\`claude\` → \`/login\`) ou defina ANTHROPIC_API_KEY.`,
    );
  }
  return new TransientError(`claude-code: ${message}`);
}
