import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AIProvider, CompletionRequest } from '../provider.js';
import { parseJsonResponse } from '../provider.js';
import { log } from '../../cli/logger.js';

export interface HttpResponse {
  status: number;
  text: string;
}

/** `onData` recebe cada pedaço do corpo conforme chega; se lançar, a requisição é abortada. */
export type HttpTransport = (
  url: string,
  body: string,
  onData?: (chunk: string) => void,
) => Promise<HttpResponse>;

export interface OllamaProviderOptions {
  baseURL?: string;
  model?: string;
  numPredict?: number;
  maxNumCtx?: number;
  transport?: HttpTransport;
}

export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:3b-instruct';
const DEFAULT_BASE_URL = 'http://localhost:11434';
const MIN_NUM_CTX = 4096;
// Um lote de backlog (um sprint, uma camada) fica em poucos milhares de tokens; 6000 já
// cortava JSON no meio. Não subir sem necessidade: em loop de repetição, cada token a mais
// é tempo de CPU perdido antes do guarda abaixo agir.
const DEFAULT_NUM_PREDICT = 8_000;
// Modelos pequenos às vezes entram em loop repetindo itens até esgotar num_predict (43 min
// medidos num chunk). Dois sinais: o trecho final exato já apareceu antes, ou um objeto
// JSON completo se repete ignorando dígitos/espaços (loop típico: mesmo item só trocando o
// id "REQ-45" → "REQ-46"). Listas de ids como as do plano de sprints não contam — só
// objetos com texto de verdade (>= REPETITION_MIN_OBJECT_CHARS).
const REPETITION_WINDOW = 400;
const REPETITION_MIN_OBJECT_CHARS = 80;
const REPETITION_CHECK_EVERY = 500;
// Limite do qwen2.5 (32k). Com 250+ requisitos o prompt do plano passa de 15k tokens e
// um teto menor faz o Ollama descartar requisitos em silêncio (truncated=1 no log).
const DEFAULT_MAX_NUM_CTX = 32_768;
// Português rende menos caracteres por token do que o inglês; ÷3 é mais conservador que o
// chunker (÷4) para garantir que o Ollama não trunque o prompt em silêncio.
const CHARS_PER_TOKEN_ESTIMATE = 3;

interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  readonly model: string;
  private readonly baseURL: string;
  private readonly numPredict: number;
  private readonly maxNumCtx: number;
  private readonly transport: HttpTransport;

  constructor(options: OllamaProviderOptions = {}) {
    this.baseURL = normalizeBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
    this.model = options.model ?? DEFAULT_OLLAMA_MODEL;
    this.numPredict = options.numPredict ?? DEFAULT_NUM_PREDICT;
    this.maxNumCtx = options.maxNumCtx ?? DEFAULT_MAX_NUM_CTX;
    this.transport = options.transport ?? postJson;
  }

  async complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<unknown> {
    const body = {
      model: this.model,
      stream: true,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      format: toJsonSchema(schema),
      options: {
        temperature: request.temperature ?? 0.2,
        num_ctx: this.estimateNumCtx(request),
        num_predict: this.numPredict,
      },
    };

    const response = await this.post(body, repetitionGuard());
    const { content, doneReason } = parseStream(response.text);
    if (!content) {
      throw new Error('resposta vazia do provedor Ollama');
    }
    if (doneReason === 'length') {
      throw new Error(
        'resposta do provedor Ollama foi cortada por limite de tokens antes de terminar o JSON',
      );
    }
    return parseJsonResponse(content);
  }

  private estimateNumCtx(request: CompletionRequest): number {
    const promptChars = request.systemPrompt.length + request.userPrompt.length;
    const estimate = Math.ceil(promptChars / CHARS_PER_TOKEN_ESTIMATE) + this.numPredict;
    return Math.min(this.maxNumCtx, Math.max(MIN_NUM_CTX, estimate));
  }

  private async post(body: unknown, onData: (chunk: string) => void): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.transport(`${this.baseURL}/api/chat`, JSON.stringify(body), onData);
    } catch (err) {
      if (isConnectionRefused(err)) {
        throw new Error(
          `Ollama não está rodando em ${this.baseURL} (inicie com \`ollama serve\`)`,
        );
      }
      throw err;
    }

    if (response.status >= 200 && response.status < 300) {
      return response;
    }
    if (response.status === 404 || /not found/i.test(response.text)) {
      throw new Error(
        `modelo "${this.model}" não encontrado no Ollama — rode \`ollama pull ${this.model}\``,
      );
    }
    throw new Error(`Ollama HTTP ${response.status}: ${response.text}`);
  }
}

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function toJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = zodToJsonSchema(schema, { $refStrategy: 'none' });
  delete jsonSchema.$schema;
  // Modelos pequenos (3B) respondem "[]" a qualquer array por ser o caminho de menor esforço;
  // com a gramática exigindo ao menos um item, o mesmo modelo extrai dezenas de requisitos
  // válidos. O pipeline só chama arrays quando há conteúdo a extrair.
  if (jsonSchema.type === 'array' && jsonSchema.minItems === undefined) {
    jsonSchema.minItems = 1;
  }
  return jsonSchema;
}

function isConnectionRefused(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } }).code;
  const causeCode = (err as { cause?: { code?: string } }).cause?.code;
  return code === 'ECONNREFUSED' || causeCode === 'ECONNREFUSED';
}

// node:http em vez de fetch: o fetch do Node aborta em 300s se os headers não chegarem, e o
// Ollama só envia os headers no primeiro token — em CPU, processar um prompt grande pode
// passar de 5 minutos antes disso.
function postJson(
  url: string,
  body: string,
  onData?: (chunk: string) => void,
): Promise<HttpResponse> {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          try {
            onData?.(chunk.toString('utf-8'));
          } catch (err) {
            req.destroy();
            reject(err);
          }
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf-8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Acumula o conteúdo gerado a partir do NDJSON parcial e lança ao detectar repetição. */
function repetitionGuard(): (chunk: string) => void {
  let pending = '';
  let content = '';
  let lastCheckedAt = 0;
  return (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        content += (JSON.parse(line) as OllamaChatChunk).message?.content ?? '';
      } catch {
        // linha incompleta/inesperada: o parse final (parseStream) reporta o erro
      }
    }
    if (content.length - lastCheckedAt < REPETITION_CHECK_EVERY) return;
    lastCheckedAt = content.length;
    if (hasRepetition(content)) {
      log.step(`ollama: loop de repetição detectado após ${content.length} chars; abortando e retentando`);
      throw new Error(
        'Ollama entrou em loop de repetição (mesmo trecho gerado mais de uma vez); geração abortada',
      );
    }
  };
}

export function hasRepetition(content: string, window = REPETITION_WINDOW): boolean {
  return hasExactTailRepetition(content, window) || hasRepeatedObject(content);
}

function hasExactTailRepetition(content: string, window: number): boolean {
  if (content.length < window * 2) return false;
  const tail = content.slice(-window);
  return content.lastIndexOf(tail, content.length - window - 1) !== -1;
}

function hasRepeatedObject(content: string): boolean {
  // O último pedaço pode ser um objeto ainda em geração; só comparamos os completos.
  const objects = content.split(/}\s*,\s*{/).slice(0, -1);
  const seen = new Set<string>();
  for (const object of objects) {
    const key = object.replace(/\d+/g, '0').replace(/\s+/g, '');
    if (key.length < REPETITION_MIN_OBJECT_CHARS) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function parseStream(raw: string): { content: string; doneReason?: string } {
  let content = '';
  let doneReason: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line) as OllamaChatChunk;
    if (chunk.error) {
      throw new Error(`Ollama: ${chunk.error}`);
    }
    content += chunk.message?.content ?? '';
    if (chunk.done && chunk.done_reason) {
      doneReason = chunk.done_reason;
    }
  }
  return doneReason === undefined ? { content } : { content, doneReason };
}
