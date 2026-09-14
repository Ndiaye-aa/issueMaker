import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AIClient, AIProvider, CompletionRequest } from './provider.js';
import { formatUsage, isRateLimitError, isTransientError } from './provider.js';
import { Semaphore } from '../util/concurrency.js';

/**
 * Orçamento total de espera por rate limit num mesmo provedor. Throttles por minuto
 * devolvem 429 repetidos com retry-after curto até a janela virar, então vale insistir
 * com backoff até este limite; um retry-after maior que ele reflete reset de cota (ex.:
 * limite diário) e é melhor cair no fallback na hora — mesmo um Ollama lento em CPU é
 * mais rápido que esperar.
 */
const MAX_AUTO_RETRY_WAIT_MS = 120_000;

export interface ConcurrencyOptions {
  /** Chamadas simultâneas permitidas no provedor principal (API remota). */
  primary: number;
  /** Chamadas simultâneas no fallback. Ollama em CPU não ganha nada com paralelismo. */
  fallback: number;
}

const DEFAULT_CONCURRENCY: ConcurrencyOptions = { primary: 1, fallback: 1 };

export class ResilientAIClient implements AIClient {
  private primaryTripped = false;
  private readonly primarySlots: Semaphore;
  private readonly fallbackSlots: Semaphore;

  /**
   * `fallback` é opcional: sem ele, um rate limit que estoure o orçamento de espera
   * propaga como erro em vez de trocar de provedor.
   */
  constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider | undefined,
    private readonly maxSchemaRetries = 3,
    private readonly maxRateLimitRetries = 8,
    private readonly log: (message: string) => void = console.error,
    concurrency: ConcurrencyOptions = DEFAULT_CONCURRENCY,
  ) {
    this.primarySlots = new Semaphore(Math.max(1, concurrency.primary));
    this.fallbackSlots = new Semaphore(Math.max(1, concurrency.fallback));
  }

  /** Uma linha por provedor que fez chamadas, com os tokens que ele conseguiu medir. */
  usageReport(): string[] {
    return [this.primary, this.fallback]
      .map((provider) => (provider ? formatUsage(provider) : undefined))
      .filter((line): line is string => line !== undefined)
      .map((line) => `uso de IA: ${line}`);
  }

  async complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<T> {
    const fallback = this.fallback;
    if (this.primaryTripped && fallback) {
      return this.runOnFallback(fallback, request, schema);
    }
    try {
      return await this.primarySlots.run(() =>
        this.withRateLimitRetry(this.primary, request, schema),
      );
    } catch (err) {
      if (!isRateLimitError(err) || !fallback) {
        throw err;
      }
      this.tripPrimary(fallback, err.retryAfterMs);
      return this.runOnFallback(fallback, request, schema);
    }
  }

  private runOnFallback<T>(
    fallback: AIProvider,
    request: CompletionRequest,
    schema: ZodType<T>,
  ): Promise<T> {
    return this.fallbackSlots.run(() => this.withRateLimitRetry(fallback, request, schema));
  }

  private tripPrimary(fallback: AIProvider, retryAfterMs: number | undefined): void {
    if (this.primaryTripped) return;
    this.primaryTripped = true;
    const retryHint =
      retryAfterMs === undefined ? '' : ` (retry-after ${Math.ceil(retryAfterMs / 1000)}s)`;
    const fallbackModel = fallback.model ? `: ${fallback.model}` : '';
    this.log(
      `[sdd-bot] ${this.primary.name} sem cota${retryHint}. ` +
        `O restante do pipeline vai rodar no ${fallback.name}${fallbackModel}.`,
    );
  }

  private async withRateLimitRetry<T>(
    provider: AIProvider,
    request: CompletionRequest,
    schema: ZodType<T>,
  ): Promise<T> {
    let lastError: unknown;
    let waitedMs = 0;
    for (let attempt = 0; attempt < this.maxRateLimitRetries; attempt++) {
      try {
        return await this.withSchemaRetry(provider, request, schema);
      } catch (err) {
        lastError = err;
        if (!isRateLimitError(err)) {
          throw err;
        }
        const delayMs = Math.max(err.retryAfterMs ?? 0, exponentialDelayMs(attempt));
        if (waitedMs + delayMs > MAX_AUTO_RETRY_WAIT_MS) {
          throw err;
        }
        waitedMs += delayMs;
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  /**
   * Repete a chamada quando a resposta não passa no schema (anexando o erro ao prompt para
   * o modelo se corrigir) ou quando a falha é transitória (rede/5xx/loop de geração — aí o
   * prompt é reenviado como está, porque o problema não foi o conteúdo).
   */
  private async withSchemaRetry<T>(
    provider: AIProvider,
    request: CompletionRequest,
    schema: ZodType<T>,
  ): Promise<T> {
    let currentRequest = request;
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxSchemaRetries; attempt++) {
      try {
        const raw = await provider.complete(currentRequest, schema);
        return schema.parse(raw);
      } catch (err) {
        if (isRateLimitError(err)) {
          throw err;
        }
        lastError = err;
        if (!isTransientError(err)) {
          currentRequest = appendSchemaErrorToPrompt(currentRequest, err);
        }
        await sleep(exponentialDelayMs(attempt));
      }
    }
    throw lastError;
  }
}

function appendSchemaErrorToPrompt(request: CompletionRequest, err: unknown): CompletionRequest {
  const errorMessage = err instanceof z.ZodError ? JSON.stringify(err.issues) : String(err);
  return {
    ...request,
    userPrompt: `${request.userPrompt}\n\nSua resposta anterior falhou nesta validação: ${errorMessage}. Corrija.`,
  };
}

function exponentialDelayMs(attempt: number): number {
  return 2 ** attempt * 250;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
