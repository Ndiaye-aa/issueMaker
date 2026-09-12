import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AIProvider, CompletionRequest } from './provider.js';
import { isRateLimitError } from './provider.js';

/**
 * Acima disso, o retry-after reportado pelo provedor reflete reset de cota (ex.: limite
 * diário), não um throttle passageiro — não vale a pena bloquear o processo esperando;
 * é melhor cair no fallback imediatamente.
 */
const MAX_AUTO_RETRY_WAIT_MS = 5_000;

export class ResilientAIClient {
  constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider,
    private readonly maxSchemaRetries = 3,
    private readonly maxRateLimitRetries = 2,
  ) {}

  async complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<T> {
    try {
      return await this.withRateLimitRetry(this.primary, request, schema);
    } catch (err) {
      if (isRateLimitError(err)) {
        return await this.withRateLimitRetry(this.fallback, request, schema);
      }
      throw err;
    }
  }

  private async withRateLimitRetry<T>(
    provider: AIProvider,
    request: CompletionRequest,
    schema: ZodType<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRateLimitRetries; attempt++) {
      try {
        return await this.withSchemaRetry(provider, request, schema);
      } catch (err) {
        lastError = err;
        if (!isRateLimitError(err)) {
          throw err;
        }
        if (err.retryAfterMs !== undefined && err.retryAfterMs > MAX_AUTO_RETRY_WAIT_MS) {
          throw err;
        }
        await backoff(attempt, err.retryAfterMs);
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
        await backoff(attempt);
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

function backoff(attempt: number, retryAfterMs?: number): Promise<void> {
  const delayMs = retryAfterMs ?? 2 ** attempt * 250;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
