import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { AIClient, CompletionRequest } from './provider.js';

/** Cliente que sabe resumir o que consumiu; é o que os comandos recebem da fábrica. */
export interface ReportingAIClient extends AIClient {
  usageReport(): string[];
}

export const DEFAULT_CACHE_DIR = '.sdd-bot-cache';

interface CacheEntry {
  createdAt: string;
  request: CompletionRequest;
  response: unknown;
}

/**
 * Memoiza respostas de IA em disco, chaveadas pelo prompt + schema + assinatura do
 * provedor. Reexecutar o pipeline sobre o mesmo SDD (após uma falha na etapa 3, ou para
 * ajustar só a publicação) deixa de custar cota da Groq e minutos de Ollama em CPU.
 *
 * Só respostas que já passaram no schema são gravadas; ao ler, o schema é validado de
 * novo para que uma mudança de schema invalide entradas antigas automaticamente.
 */
export class CachedAIClient implements AIClient {
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: AIClient,
    private readonly dir: string,
    private readonly signature: string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  usageReport(): string[] {
    const inner = this.inner as Partial<ReportingAIClient>;
    const lines = typeof inner.usageReport === 'function' ? inner.usageReport() : [];
    if (this.hits + this.misses === 0) return lines;
    return [...lines, `cache em disco: ${this.hits} hit(s) / ${this.misses} miss(es)`];
  }

  async complete<T>(request: CompletionRequest, schema: ZodType<T>): Promise<T> {
    const schemaJson = z.toJSONSchema(schema, { target: 'draft-7' });
    const key = createHash('sha256')
      .update(JSON.stringify({ signature: this.signature, request, schema: schemaJson }))
      .digest('hex');
    const path = join(this.dir, key.slice(0, 2), `${key}.json`);

    const cached = await this.read(path, schema);
    if (cached !== undefined) {
      this.hits += 1;
      this.log(`cache hit (${key.slice(0, 8)})`);
      return cached;
    }

    this.misses += 1;
    const response = await this.inner.complete(request, schema);
    await this.write(path, { createdAt: new Date().toISOString(), request, response });
    return response;
  }

  private async read<T>(path: string, schema: ZodType<T>): Promise<T | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return undefined;
    }
    try {
      const entry = JSON.parse(raw) as CacheEntry;
      const parsed = schema.safeParse(entry.response);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(path: string, entry: CacheEntry): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      // Escrita atômica: duas chamadas paralelas com a mesma chave não corrompem o arquivo.
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(entry), 'utf-8');
      await rename(tmp, path);
    } catch (err) {
      this.log(`cache: falha ao gravar ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
