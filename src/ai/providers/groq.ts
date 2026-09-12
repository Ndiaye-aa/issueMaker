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
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: GroqProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? 'https://api.groq.com/openai/v1',
    });
    this.model = options.model ?? 'llama-3.3-70b-versatile';
  }

  async complete<T>(request: CompletionRequest, _schema: ZodType<T>): Promise<unknown> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: request.temperature ?? 0.2,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
      });
      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('resposta vazia do provedor Groq');
      }
      return parseJsonResponse(content);
    } catch (err) {
      if (isOpenAIRateLimitError(err)) {
        throw new RateLimitError('Groq retornou HTTP 429');
      }
      throw err;
    }
  }
}

function isOpenAIRateLimitError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: number }).status === 429
  );
}
