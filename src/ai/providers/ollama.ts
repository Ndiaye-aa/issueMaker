import OpenAI from 'openai';
import type { ZodType } from 'zod';
import type { AIProvider, CompletionRequest } from '../provider.js';
import { parseJsonResponse } from '../provider.js';

export interface OllamaProviderOptions {
  baseURL?: string;
  model?: string;
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OllamaProviderOptions = {}) {
    this.client = new OpenAI({
      apiKey: 'ollama',
      baseURL: options.baseURL ?? 'http://localhost:11434/v1',
    });
    this.model = options.model ?? 'qwen2.5:14b-instruct';
  }

  async complete<T>(request: CompletionRequest, _schema: ZodType<T>): Promise<unknown> {
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
      throw new Error('resposta vazia do provedor Ollama');
    }
    return parseJsonResponse(content);
  }
}
