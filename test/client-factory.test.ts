import { jest } from '@jest/globals';
import { createResilientAIClient } from '../src/ai/client-factory.js';

describe('createResilientAIClient', () => {
  const originalEnv = process.env;
  let stderr: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv, GROQ_API_KEY: 'key' };
    delete process.env.OLLAMA_MODEL;
    delete process.env.OLLAMA_BASE_URL;
    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    stderr.mockRestore();
  });

  it('falha sem GROQ_API_KEY', () => {
    delete process.env.GROQ_API_KEY;
    expect(() => createResilientAIClient()).toThrow('GROQ_API_KEY não definida');
  });

  it('usa qwen2.5:3b-instruct como fallback padrão e anuncia os provedores', () => {
    const client = createResilientAIClient();

    expect(fallbackOf(client).model).toBe('qwen2.5:3b-instruct');
    expect(stderr).toHaveBeenCalledWith(
      '[sdd-bot] provedores: groq=openai/gpt-oss-120b → fallback ollama=qwen2.5:3b-instruct',
    );
  });

  it('respeita OLLAMA_MODEL', () => {
    process.env.OLLAMA_MODEL = 'llama3.1:8b';
    expect(fallbackOf(createResilientAIClient()).model).toBe('llama3.1:8b');
  });
});

function fallbackOf(client: unknown): { model: string } {
  return (client as { fallback: { model: string } }).fallback;
}
