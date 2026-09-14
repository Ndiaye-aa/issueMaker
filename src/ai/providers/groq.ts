import OpenAI from 'openai';
import type { ZodType } from 'zod';
import type { AIProvider, CompletionRequest } from '../provider.js';
import { RateLimitError, parseJsonResponse } from '../provider.js';

export interface GroqProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class GroqProvider implements AIProvider {
  readonly name = 'groq';
  readonly model: string;
  private readonly client: OpenAI;

  constructor(options: GroqProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? 'https://api.groq.com/openai/v1',
    });
    this.model = options.model ?? 'openai/gpt-oss-120b';
  }

  async complete<T>(request: CompletionRequest, _schema: ZodType<T>): Promise<unknown> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: request.temperature ?? 0.2,
        // Modelos de raciocínio (gpt-oss) contam os tokens de raciocínio aqui; 6000 cortava
        // extrações grandes antes de terminar o JSON.
        max_tokens: 16_000,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
      });
      const choice = response.choices[0];
      const content = choice?.message?.content;
      if (!content) {
        throw new Error('resposta vazia do provedor Groq');
      }
      if (choice.finish_reason === 'length') {
        throw new Error(
          'resposta do provedor Groq foi cortada por limite de tokens antes de terminar o JSON',
        );
      }
      return parseJsonResponse(content);
    } catch (err) {
      if (isOpenAIRateLimitError(err)) {
        throw new RateLimitError(
          `Groq retornou rate limit (HTTP ${(err as { status?: number }).status})`,
          getRetryAfterMs(err),
        );
      }
      throw err;
    }
  }
}

function isOpenAIRateLimitError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: number }).status;
  const code = (err as { code?: string }).code;
  // A Groq também retorna 413 (não só 429) quando o request excede o orçamento
  // de tokens-por-minuto do plano — ambos são, na prática, rate limiting.
  return status === 429 || code === 'rate_limit_exceeded';
}

function getRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> }).headers;
  const retryAfter = headers?.['retry-after'];
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
