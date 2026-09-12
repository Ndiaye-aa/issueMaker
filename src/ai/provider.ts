import type { ZodType } from 'zod';

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface AIProvider {
  readonly name: string;
  complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<unknown>;
}

export class RateLimitError extends Error {
  constructor(message = 'rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
  }
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError;
}

export function parseJsonResponse(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : content;
  return JSON.parse((raw ?? '').trim());
}
