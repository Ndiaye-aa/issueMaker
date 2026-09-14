import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { CachedAIClient, DEFAULT_CACHE_DIR, type ReportingAIClient } from './cache.js';
import { ResilientAIClient } from './client.js';
import type { AIProvider } from './provider.js';
import {
  ClaudeCodeProvider,
  EFFORT_LEVELS,
  THINKING_MODES,
  type ThinkingMode,
} from './providers/claude-code.js';
import { OllamaProvider } from './providers/ollama.js';
import {
  DEFAULT_GROQ_MODEL,
  DEFAULT_OPENAI_MODEL,
  GROQ_BASE_URL,
  OPENAI_BASE_URL,
  OpenAICompatibleProvider,
} from './providers/openai-compatible.js';
import { log } from '../cli/logger.js';

export const PROVIDER_KINDS = ['claude-code', 'openai', 'groq', 'ollama'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const DEFAULT_PRIMARY: ProviderKind = 'claude-code';
const DEFAULT_FALLBACK: ProviderKind | 'none' = 'ollama';
// APIs remotas toleram algumas chamadas simultâneas; acima disso só antecipa o 429.
const DEFAULT_CONCURRENCY = 3;
// O system prompt do backlog é a maior fatia da entrada de todo o pipeline, e é reenviado
// uma vez por chamada: agrupar requisitos da mesma sprint nele é o maior ganho de tokens
// disponível. 4 equilibra economia (menos chamadas) com rigor por requisito.
const DEFAULT_BACKLOG_BATCH_SIZE = 4;

export interface AIClientOptions {
  /** Desliga o cache em disco de respostas (equivale a SDD_BOT_CACHE=0). */
  cache?: boolean;
}

export interface ProviderSelection {
  primary: ProviderKind;
  fallback: ProviderKind | undefined;
}

/** Lê e valida AI_PRIMARY / AI_FALLBACK. */
export function readProviderSelection(env: NodeJS.ProcessEnv = process.env): ProviderSelection {
  const primary = parseKind(env.AI_PRIMARY, DEFAULT_PRIMARY, 'AI_PRIMARY');
  const fallbackRaw = (env.AI_FALLBACK ?? DEFAULT_FALLBACK).trim().toLowerCase();
  const fallback = fallbackRaw === 'none' ? undefined : parseKind(fallbackRaw, DEFAULT_FALLBACK as ProviderKind, 'AI_FALLBACK');
  if (fallback === primary) {
    throw new Error(
      `AI_PRIMARY e AI_FALLBACK não podem ser o mesmo provedor ("${primary}"). Use AI_FALLBACK=none para desligar o fallback.`,
    );
  }
  return { primary, fallback };
}

function parseKind(raw: string | undefined, fallback: ProviderKind, variable: string): ProviderKind {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if ((PROVIDER_KINDS as readonly string[]).includes(value)) return value as ProviderKind;
  throw new Error(
    `${variable} inválido: "${raw}". Valores aceitos: ${PROVIDER_KINDS.join(', ')}${variable === 'AI_FALLBACK' ? ', none' : ''}.`,
  );
}

/** Instancia um provedor a partir das variáveis de ambiente dele, com erro nomeado se faltar credencial. */
export function buildProvider(kind: ProviderKind, env: NodeJS.ProcessEnv = process.env): AIProvider {
  switch (kind) {
    case 'claude-code': {
      const timeoutMs = readPositiveInt(env.CLAUDE_TIMEOUT_MS);
      const effort = readEnum(env.CLAUDE_EFFORT, EFFORT_LEVELS, 'CLAUDE_EFFORT');
      const thinking = readEnum(env.CLAUDE_THINKING, THINKING_MODES, 'CLAUDE_THINKING');
      return new ClaudeCodeProvider({
        ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
        ...(env.CLAUDE_LIGHT_MODEL ? { lightModel: env.CLAUDE_LIGHT_MODEL } : {}),
        ...(effort !== undefined ? { effort: effort as EffortLevel } : {}),
        ...(thinking !== undefined ? { thinking: thinking as ThinkingMode } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
    case 'groq':
      return new OpenAICompatibleProvider({
        name: 'groq',
        apiKey: requireEnv(env, 'GROQ_API_KEY', kind),
        baseURL: GROQ_BASE_URL,
        model: env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
      });
    case 'openai':
      return new OpenAICompatibleProvider({
        name: 'openai',
        apiKey: requireEnv(env, 'OPENAI_API_KEY', kind),
        baseURL: env.OPENAI_BASE_URL || OPENAI_BASE_URL,
        model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      });
    case 'ollama':
      return new OllamaProvider({
        ...(env.OLLAMA_BASE_URL ? { baseURL: env.OLLAMA_BASE_URL } : {}),
        ...(env.OLLAMA_MODEL ? { model: env.OLLAMA_MODEL } : {}),
      });
  }
}

function readEnum<T extends string>(
  raw: string | undefined,
  accepted: readonly T[],
  variable: string,
): T | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return undefined;
  if ((accepted as readonly string[]).includes(value)) return value as T;
  throw new Error(`${variable} inválido: "${raw}". Valores aceitos: ${accepted.join(', ')}.`);
}

function requireEnv(env: NodeJS.ProcessEnv, variable: string, kind: ProviderKind): string {
  const value = env[variable];
  if (!value) {
    throw new Error(
      `provedor "${kind}" exige ${variable}. Configure o arquivo .env (ver .env.example).`,
    );
  }
  return value;
}

export function createResilientAIClient(): ResilientAIClient {
  const selection = readProviderSelection();
  const primary = buildProvider(selection.primary);
  const fallback = selection.fallback ? buildProvider(selection.fallback) : undefined;

  const concurrency = readPositiveInt(process.env.AI_CONCURRENCY) ?? DEFAULT_CONCURRENCY;
  const primaryConcurrency = selection.primary === 'ollama' ? 1 : concurrency;
  const fallbackConcurrency = selection.fallback === 'ollama' ? 1 : concurrency;

  const fallbackLabel = fallback ? `fallback ${describe(fallback)}` : 'sem fallback';
  log.step(
    `provedores: ${describe(primary)} (até ${primaryConcurrency} chamada(s) simultânea(s)) → ${fallbackLabel}`,
  );
  return new ResilientAIClient(primary, fallback, 3, 8, console.error, {
    primary: primaryConcurrency,
    fallback: fallbackConcurrency,
  });
}

/** Cliente usado pelos comandos: resiliente + cache em disco (a menos que desligado). */
export function createAIClient(options: AIClientOptions = {}): ReportingAIClient {
  const resilient = createResilientAIClient();
  const cacheEnabled = options.cache ?? process.env.SDD_BOT_CACHE !== '0';
  if (!cacheEnabled) {
    return resilient;
  }
  const dir = process.env.SDD_BOT_CACHE_DIR || DEFAULT_CACHE_DIR;
  const primary = (resilient as unknown as { primary: AIProvider }).primary;
  const signature = describe(primary);
  log.step(`cache de respostas em ${dir} (desligue com --no-cache ou SDD_BOT_CACHE=0)`);
  return new CachedAIClient(resilient, dir, signature, (message) => log.step(message));
}

/** Imprime o resumo de consumo no fim de um comando (também após falha, via finally). */
export function logUsage(client: ReportingAIClient): void {
  for (const line of client.usageReport()) log.step(line);
}

/**
 * Quantos requisitos por chamada de backlog (BACKLOG_BATCH_SIZE, default 4). Forçado a 1
 * quando o provedor principal é o Ollama: modelos pequenos e locais perdem rigor com vários
 * requisitos por prompt (ver comentário em BuildBacklogOptions).
 */
export function readBacklogBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const configured = readPositiveInt(env.BACKLOG_BATCH_SIZE) ?? DEFAULT_BACKLOG_BATCH_SIZE;
  const primary = readProviderSelection(env).primary;
  return primary === 'ollama' ? 1 : configured;
}

function describe(provider: AIProvider): string {
  return provider.model ? `${provider.name}=${provider.model}` : provider.name;
}

function readPositiveInt(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
