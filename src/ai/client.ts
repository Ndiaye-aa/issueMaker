import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AIProvider, CompletionRequest } from './provider.js';
import { isRateLimitError } from './provider.js';

/**
 * Orçamento total de espera por rate limit num mesmo provedor. Throttles por minuto
 * devolvem 429 repetidos com retry-after curto até a janela virar, então vale insistir
 * com backoff até este limite; um retry-after maior que ele reflete reset de cota (ex.:
 * limite diário) e é melhor cair no fallback na hora — mesmo um Ollama lento em CPU é
 * mais rápido que esperar.
 */
const MAX_AUTO_RETRY_WAIT_MS = 120_000;

export class ResilientAIClient {
  private primaryTripped = false;

  constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider,
    private readonly maxSchemaRetries = 3,
    private readonly maxRateLimitRetries = 8,
    private readonly log: (message: string) => void = console.error,
  ) {}

  async complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<T> {
    if (this.primaryTripped) {
      return this.withRateLimitRetry(this.fallback, request, schema);
    }
    try {
      return await this.withRateLimitRetry(this.primary, request, schema);
    } catch (err) {
      if (!isRateLimitError(err)) {
        throw err;
      }
      this.tripPrimary(err.retryAfterMs);
      return this.withRateLimitRetry(this.fallback, request, schema);
    }
  }

  private tripPrimary(retryAfterMs: number | undefined): void {
    this.primaryTripped = true;
    const retryHint =
      retryAfterMs === undefined ? '' : ` (retry-after ${Math.ceil(retryAfterMs / 1000)}s)`;
    const fallbackModel = this.fallback.model ? `: ${this.fallback.model}` : '';
    this.log(
      `[sdd-bot] ${this.primary.name} sem cota${retryHint}. ` +
        `O restante do pipeline vai rodar no ${this.fallback.name}${fallbackModel}.`,
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
        currentRequest = appendSchemaErrorToPrompt(currentRequest, err);
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
