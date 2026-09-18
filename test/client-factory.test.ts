import { jest } from '@jest/globals';
import {
  buildProvider,
  createAIClient,
  createResilientAIClient,
  readBacklogBatchSize,
  readProviderSelection,
} from '../src/ai/client-factory.js';
import { CachedAIClient } from '../src/ai/cache.js';
import { ResilientAIClient } from '../src/ai/client.js';

const AI_VARS = [
  'AI_PRIMARY', 'AI_FALLBACK', 'AI_CONCURRENCY', 'SDD_BOT_CACHE', 'GROQ_API_KEY', 'GROQ_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OLLAMA_MODEL', 'OLLAMA_BASE_URL',
  'CLAUDE_MODEL', 'CLAUDE_TIMEOUT_MS', 'CLAUDE_LIGHT_MODEL', 'CLAUDE_EFFORT', 'CLAUDE_THINKING',
  'BACKLOG_BATCH_SIZE',
];

describe('client-factory', () => {
  const originalEnv = process.env;
  let stderr: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of AI_VARS) delete process.env[name];
    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    stderr.mockRestore();
  });

  describe('readProviderSelection', () => {
    it('usa claude-code → ollama por padrão', () => {
      expect(readProviderSelection({})).toEqual({ primary: 'claude-code', fallback: 'ollama' });
    });

    it('aceita qualquer combinação e none para desligar o fallback', () => {
      expect(readProviderSelection({ AI_PRIMARY: 'groq', AI_FALLBACK: 'ollama' })).toEqual({ primary: 'groq', fallback: 'ollama' });
      expect(readProviderSelection({ AI_PRIMARY: 'OpenAI', AI_FALLBACK: 'NONE' })).toEqual({ primary: 'openai', fallback: undefined });
      expect(readProviderSelection({ AI_PRIMARY: 'ollama', AI_FALLBACK: 'claude-code' })).toEqual({ primary: 'ollama', fallback: 'claude-code' });
    });

    it('rejeita provedor desconhecido listando os aceitos', () => {
      expect(() => readProviderSelection({ AI_PRIMARY: 'xyz' })).toThrow(/AI_PRIMARY inválido: "xyz".*claude-code, openai, groq, ollama/);
      expect(() => readProviderSelection({ AI_FALLBACK: 'xyz' })).toThrow(/AI_FALLBACK inválido.*none/);
    });

    it('rejeita principal e fallback iguais', () => {
      expect(() => readProviderSelection({ AI_PRIMARY: 'groq', AI_FALLBACK: 'groq' })).toThrow(/não podem ser o mesmo provedor/);
    });
  });

  describe('buildProvider', () => {
    it('groq exige GROQ_API_KEY e usa o preset da Groq', () => {
      expect(() => buildProvider('groq', {})).toThrow('provedor "groq" exige GROQ_API_KEY');
      const provider = buildProvider('groq', { GROQ_API_KEY: 'k' });
      expect(provider.name).toBe('groq');
      expect(provider.model).toBe('openai/gpt-oss-120b');
      expect(buildProvider('groq', { GROQ_API_KEY: 'k', GROQ_MODEL: 'llama' }).model).toBe('llama');
    });

    it('openai exige OPENAI_API_KEY e respeita base URL/modelo', () => {
      expect(() => buildProvider('openai', {})).toThrow('provedor "openai" exige OPENAI_API_KEY');
      const provider = buildProvider('openai', { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-x', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' });
      expect(provider.name).toBe('openai');
      expect(provider.model).toBe('gpt-x');
      expect((provider as unknown as { client: { baseURL: string } }).client.baseURL).toBe('https://openrouter.ai/api/v1');
    });

    it('claude-code não exige chave e usa claude-sonnet-5 por padrão', () => {
      const provider = buildProvider('claude-code', {});
      expect(provider.name).toBe('claude-code');
      expect(provider.model).toBe('claude-sonnet-5');
      expect(buildProvider('claude-code', { CLAUDE_MODEL: 'claude-opus-5' }).model).toBe('claude-opus-5');
    });

    it('claude-code lê CLAUDE_LIGHT_MODEL, CLAUDE_EFFORT e CLAUDE_THINKING', () => {
      const provider = buildProvider('claude-code', {
        CLAUDE_LIGHT_MODEL: 'claude-haiku-4-5-20251001',
        CLAUDE_EFFORT: 'high',
        CLAUDE_THINKING: 'adaptive',
      }) as unknown as { lightModel: string; effort: string; thinking: string };
      expect(provider.lightModel).toBe('claude-haiku-4-5-20251001');
      expect(provider.effort).toBe('high');
      expect(provider.thinking).toBe('adaptive');
    });

    it('rejeita CLAUDE_EFFORT / CLAUDE_THINKING inválidos', () => {
      expect(() => buildProvider('claude-code', { CLAUDE_EFFORT: 'ultra' })).toThrow(
        /CLAUDE_EFFORT inválido: "ultra".*low, medium, high, xhigh, max/,
      );
      expect(() => buildProvider('claude-code', { CLAUDE_THINKING: 'on' })).toThrow(
        /CLAUDE_THINKING inválido: "on".*disabled, adaptive/,
      );
    });

    it('ollama não exige chave e respeita OLLAMA_MODEL', () => {
      expect(buildProvider('ollama', {}).model).toBe('qwen2.5:3b-instruct');
      expect(buildProvider('ollama', { OLLAMA_MODEL: 'llama3.1:8b' }).model).toBe('llama3.1:8b');
    });
  });

  describe('createResilientAIClient', () => {
    it('anuncia os provedores e a concorrência', () => {
      process.env.AI_PRIMARY = 'groq';
      process.env.GROQ_API_KEY = 'key';
      const client = createResilientAIClient();

      expect(fallbackOf(client)?.model).toBe('qwen2.5:3b-instruct');
      expect(stderr).toHaveBeenCalledWith(
        '[sdd-bot] provedores: groq=openai/gpt-oss-120b (até 3 chamada(s) simultânea(s)) → fallback ollama=qwen2.5:3b-instruct',
      );
    });

    it('sem fallback, anuncia "sem fallback" e não instancia o segundo provedor', () => {
      process.env.AI_FALLBACK = 'none';
      const client = createResilientAIClient();
      expect(fallbackOf(client)).toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/claude-code=claude-sonnet-5 .*→ sem fallback$/));
    });

    it('ollama como principal roda serial mesmo com AI_CONCURRENCY alto', () => {
      process.env.AI_PRIMARY = 'ollama';
      process.env.AI_FALLBACK = 'none';
      process.env.AI_CONCURRENCY = '5';
      createResilientAIClient();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('até 1 chamada(s)'));
    });

    it('respeita AI_CONCURRENCY e ignora valores inválidos', () => {
      process.env.AI_CONCURRENCY = '5';
      createResilientAIClient();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('até 5 chamada(s)'));

      process.env.AI_CONCURRENCY = 'abc';
      createResilientAIClient();
      expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining('até 3 chamada(s)'));
    });

    it('propaga o erro de credencial faltando do provedor escolhido', () => {
      process.env.AI_PRIMARY = 'groq';
      expect(() => createResilientAIClient()).toThrow('exige GROQ_API_KEY');
    });
  });

  describe('createAIClient', () => {
    it('envolve em cache por padrão, com assinatura do provedor principal', () => {
      const client = createAIClient();
      expect(client).toBeInstanceOf(CachedAIClient);
      expect((client as unknown as { signature: string }).signature).toBe('claude-code=claude-sonnet-5');
    });

    it('desliga o cache com a opção ou com SDD_BOT_CACHE=0', () => {
      expect(createAIClient({ cache: false })).toBeInstanceOf(ResilientAIClient);
      process.env.SDD_BOT_CACHE = '0';
      expect(createAIClient()).toBeInstanceOf(ResilientAIClient);
    });
  });

  describe('readBacklogBatchSize', () => {
    it('usa 4 por padrão', () => {
      expect(readBacklogBatchSize({})).toBe(4);
    });

    it('respeita BACKLOG_BATCH_SIZE e ignora valores inválidos', () => {
      expect(readBacklogBatchSize({ BACKLOG_BATCH_SIZE: '8' })).toBe(8);
      expect(readBacklogBatchSize({ BACKLOG_BATCH_SIZE: 'abc' })).toBe(4);
      expect(readBacklogBatchSize({ BACKLOG_BATCH_SIZE: '0' })).toBe(4);
    });

    it('força 1 quando o provedor principal é ollama, mesmo com BACKLOG_BATCH_SIZE alto', () => {
      expect(
        readBacklogBatchSize({ AI_PRIMARY: 'ollama', AI_FALLBACK: 'none', BACKLOG_BATCH_SIZE: '8' }),
      ).toBe(1);
    });
  });
});

function fallbackOf(client: unknown): { model?: string } | undefined {
  return (client as { fallback?: { model?: string } }).fallback;
}
