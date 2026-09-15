import type { ZodType } from 'zod';

/**
 * Peso da tarefa para o provedor escolher o modelo: 'light' é para decisões mecânicas
 * (ex.: confirmar duplicata com sim/não), que um modelo pequeno resolve mais barato.
 * Provedores sem um modelo leve configurado ignoram o campo. Default: 'standard'.
 */
export type CompletionTier = 'light' | 'standard';

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  tier?: CompletionTier;
}

/** Tokens acumulados por um provedor ao longo do processo (só o que ele conseguir medir). */
export interface ProviderUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Já contados em outputTokens; separados porque são invisíveis no JSON devolvido. */
  thinkingTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export function emptyUsage(): ProviderUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

/** Soma `delta` em `total` (in place); campos ausentes contam como zero. */
export function addUsage(
  total: ProviderUsage,
  delta: { [K in keyof ProviderUsage]?: ProviderUsage[K] | undefined },
): ProviderUsage {
  total.calls += delta.calls ?? 0;
  total.inputTokens += delta.inputTokens ?? 0;
  total.outputTokens += delta.outputTokens ?? 0;
  total.thinkingTokens += delta.thinkingTokens ?? 0;
  total.cacheReadInputTokens += delta.cacheReadInputTokens ?? 0;
  total.cacheCreationInputTokens += delta.cacheCreationInputTokens ?? 0;
  total.costUsd += delta.costUsd ?? 0;
  return total;
}

/** Ex.: 1234 → "1,2k"; 987 → "987"; 1_500_000 → "1,5M". */
export function formatTokens(count: number): string {
  const fmt = (n: number) => n.toFixed(n < 10 ? 1 : 0).replace('.', ',');
  if (count >= 1_000_000) return `${fmt(count / 1_000_000)}M`;
  if (count >= 1_000) return `${fmt(count / 1_000)}k`;
  return String(Math.round(count));
}

/** Uma linha legível com o uso de um provedor, ou undefined se ele não fez chamadas. */
export function formatUsage(provider: AIProvider): string | undefined {
  const usage = provider.usage;
  if (!usage || usage.calls === 0) return undefined;
  const label = provider.model ? `${provider.name}=${provider.model}` : provider.name;
  const cached: string[] = [];
  if (usage.cacheReadInputTokens > 0) cached.push(`+${formatTokens(usage.cacheReadInputTokens)} lidos do cache`);
  if (usage.cacheCreationInputTokens > 0) cached.push(`${formatTokens(usage.cacheCreationInputTokens)} gravados`);
  const input = `entrada ${formatTokens(usage.inputTokens)}${cached.length ? ` (${cached.join(', ')})` : ''}`;
  const thinking = usage.thinkingTokens > 0 ? ` (${formatTokens(usage.thinkingTokens)} de raciocínio)` : '';
  const output = `saída ${formatTokens(usage.outputTokens)}${thinking}`;
  const cost = usage.costUsd > 0 ? ` · ~US$ ${usage.costUsd.toFixed(2).replace('.', ',')}` : '';
  return `${label} — ${usage.calls} chamada(s) · ${input} · ${output}${cost}`;
}

export interface AIProvider {
  readonly name: string;
  readonly model?: string;
  /** Uso acumulado desde a criação do provedor; ausente quando o provedor não mede. */
  readonly usage?: ProviderUsage;
  complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<unknown>;
}

/** Identifica um provedor de forma estável para fins de log e de chave de cache. */
export function describeProvider(provider: AIProvider): string {
  return provider.model ? `${provider.name}=${provider.model}` : provider.name;
}

/** Contrato mínimo que o pipeline usa; implementado pelo cliente resiliente e pelo cache. */
export interface AIClient {
  complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<T>;
}

export class RateLimitError extends Error {
  constructor(
    message = 'rate limit exceeded',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError;
}

/**
 * Falha que não tem relação com o conteúdo da resposta (rede, 5xx, loop de geração):
 * vale repetir o MESMO prompt, sem anexar a dica de correção de schema.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

export function isTransientError(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const { status, code, cause, message } = err as {
    status?: number;
    code?: string;
    cause?: { code?: string };
    message?: string;
  };
  if (typeof status === 'number' && (status >= 500 || status === 408)) return true;
  if ((code && TRANSIENT_CODES.has(code)) || (cause?.code && TRANSIENT_CODES.has(cause.code))) {
    return true;
  }
  return typeof message === 'string' && /socket hang up|fetch failed|ECONNRESET/i.test(message);
}

export function parseJsonResponse(content: string): unknown {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : withoutThinking;
  return JSON.parse((raw ?? '').trim());
}
