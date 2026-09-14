import type { ZodType } from 'zod';

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model?: string;
  complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<unknown>;
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

export function parseJsonResponse(content: string): unknown {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : withoutThinking;
  return JSON.parse((raw ?? '').trim());
}
