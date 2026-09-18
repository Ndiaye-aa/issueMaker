import OpenAI from 'openai';
import type { ZodType } from 'zod';
import type { AIProvider, CompletionRequest, ProviderUsage } from '../provider.js';
import { RateLimitError, addUsage, emptyUsage, parseJsonResponse } from '../provider.js';

export interface OpenAICompatibleProviderOptions {
  /** Nome exibido em logs e usado na chave do cache (ex.: "groq", "openai"). */
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Qualquer API que fale o protocolo chat/completions da OpenAI: OpenAI, Groq, OpenRouter,
 * Together, Mistral, DeepSeek... A diferença entre elas é só base URL, chave e modelo.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly usageTotals: ProviderUsage = emptyUsage();

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name;
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      // O ResilientAIClient é quem faz retry/backoff; retries do SDK por baixo distorceriam
      // o orçamento de espera por rate limit.
      maxRetries: 0,
    });
  }

  get usage(): ProviderUsage {
    return { ...this.usageTotals };
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
      addUsage(this.usageTotals, {
        calls: 1,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        thinkingTokens: response.usage?.completion_tokens_details?.reasoning_tokens,
        cacheReadInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
      });
      const choice = response.choices[0];
      const content = choice?.message?.content;
      if (!content) {
        throw new Error(`resposta vazia do provedor ${this.name}`);
      }
      if (choice.finish_reason === 'length') {
        throw new Error(
          `resposta do provedor ${this.name} foi cortada por limite de tokens antes de terminar o JSON`,
        );
      }
      return parseJsonResponse(content);
    } catch (err) {
      if (isOpenAIRateLimitError(err)) {
        throw new RateLimitError(
          `${this.name} retornou rate limit (HTTP ${(err as { status?: number }).status})`,
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
  return status === 429 || code === 'rate_limit_exceeded';
}

function getRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> | Headers }).headers;
  const retryAfter =
    headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
