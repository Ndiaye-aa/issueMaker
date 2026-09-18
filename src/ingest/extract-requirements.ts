import type { AIClient } from '../ai/provider.js';
import { buildExtractRequest } from '../ai/prompts/extract.js';
import { buildDedupeConfirmRequest, DedupeConfirmSchema } from '../ai/prompts/dedupe-confirm.js';
import { log } from '../cli/logger.js';
import { RequirementArraySchema, type Requirement } from '../schemas/requirement.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { chunkDocument } from './chunker.js';
import { findSimilarPairs } from './dedupe.js';

const DEDUPE_SIMILARITY_THRESHOLD = 0.6;
// Fan-out máximo do pipeline; o limite real de chamadas simultâneas é imposto pelo
// cliente de IA (por provedor), isto só evita enfileirar centenas de promessas de uma vez.
const MAX_FAN_OUT = 8;

export async function extractRequirements(
  sddText: string,
  aiClient: AIClient,
): Promise<Requirement[]> {
  const chunks = chunkDocument(sddText);
  log.step(`${chunks.length} chunk(s) para extrair`);

  // Cada chunk é extraído de forma independente (permite paralelismo); os ids vêm locais
  // ("REQ-1", "REQ-2"...) e são renumerados aqui, em ordem de documento.
  const perChunk = await mapWithConcurrency(chunks, MAX_FAN_OUT, async (chunk, index) => {
    log.step(`extraindo chunk ${index + 1}/${chunks.length}: "${chunk.sectionTitle}"`);
    return aiClient.complete(buildExtractRequest(chunk), RequirementArraySchema);
  });

  const usedIds = new Set<string>();
  const merged: Requirement[] = [];
  for (const extracted of perChunk) {
    merged.push(...ensureUniqueIds(extracted, usedIds));
  }

  return dedupeRequirements(merged, aiClient);
}

/**
 * Modelos pequenos ignoram instruções de numeração e recomeçam em REQ-1 a cada chunk;
 * ids repetidos quebram o plano de sprints e a rastreabilidade, então renumeramos aqui e
 * reescrevemos as dependências internas ao chunk. Dependências que apontam para fora do
 * chunk são descartadas: como cada chunk é extraído isoladamente, elas só podem ser chute.
 */
export function ensureUniqueIds(extracted: Requirement[], usedIds: Set<string>): Requirement[] {
  let next = nextRequirementNumber(usedIds);
  const renamed = new Map<string, string>();

  const withIds = extracted.map((requirement) => {
    if (!usedIds.has(requirement.id) && /^REQ-\d+$/.test(requirement.id)) {
      usedIds.add(requirement.id);
      renamed.set(requirement.id, requirement.id);
      return requirement;
    }
    let candidate = `REQ-${next}`;
    while (usedIds.has(candidate)) {
      next += 1;
      candidate = `REQ-${next}`;
    }
    usedIds.add(candidate);
    renamed.set(requirement.id, candidate);
    return { ...requirement, id: candidate };
  });

  return withIds.map((requirement) => ({
    ...requirement,
    dependencies: [
      ...new Set(
        requirement.dependencies
          .map((depId) => renamed.get(depId))
          .filter((depId): depId is string => depId !== undefined && depId !== requirement.id),
      ),
    ],
  }));
}

function nextRequirementNumber(usedIds: Set<string>): number {
  let max = 0;
  for (const id of usedIds) {
    const match = /^REQ-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function dedupeRequirements(
  requirements: Requirement[],
  aiClient: AIClient,
): Promise<Requirement[]> {
  const pairs = findSimilarPairs(
    requirements,
    (requirement) => requirement.title,
    DEDUPE_SIMILARITY_THRESHOLD,
  );
  log.step(`${requirements.length} requisito(s) extraído(s); ${pairs.length} par(es) similares para confirmar`);

  // As confirmações são independentes entre si: rodam em paralelo e a decisão de qual
  // id remover é tomada depois, em ordem, para manter o resultado determinístico.
  const confirmations = await mapWithConcurrency(pairs, MAX_FAN_OUT, (pair) =>
    aiClient.complete(buildDedupeConfirmRequest(pair.a, pair.b), DedupeConfirmSchema),
  );

  const idsToRemove = new Set<string>();
  pairs.forEach((pair, index) => {
    if (idsToRemove.has(pair.a.id) || idsToRemove.has(pair.b.id)) return;
    if (confirmations[index]?.same) {
      idsToRemove.add(pair.b.id);
    }
  });

  const kept = requirements.filter((requirement) => !idsToRemove.has(requirement.id));
  if (idsToRemove.size > 0) {
    log.step(`${idsToRemove.size} duplicata(s) removida(s)`);
  }
  // Dependências para requisitos removidos como duplicata passam a apontar para o mantido.
  const replacement = new Map<string, string>();
  pairs.forEach((pair) => {
    if (idsToRemove.has(pair.b.id) && !idsToRemove.has(pair.a.id)) {
      replacement.set(pair.b.id, pair.a.id);
    }
  });
  return kept.map((requirement) => ({
    ...requirement,
    dependencies: [
      ...new Set(
        requirement.dependencies
          .map((depId) => replacement.get(depId) ?? depId)
          .filter((depId) => depId !== requirement.id),
      ),
    ],
  }));
}
