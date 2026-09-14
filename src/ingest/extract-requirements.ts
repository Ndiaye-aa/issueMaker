import type { ResilientAIClient } from '../ai/client.js';
import { buildExtractRequest } from '../ai/prompts/extract.js';
import { buildDedupeConfirmRequest, DedupeConfirmSchema } from '../ai/prompts/dedupe-confirm.js';
import { log } from '../cli/logger.js';
import { RequirementArraySchema, type Requirement } from '../schemas/requirement.js';
import { chunkDocument } from './chunker.js';
import { findSimilarPairs } from './dedupe.js';

const DEDUPE_SIMILARITY_THRESHOLD = 0.6;

export async function extractRequirements(
  sddText: string,
  aiClient: ResilientAIClient,
): Promise<Requirement[]> {
  const chunks = chunkDocument(sddText);
  const merged: Requirement[] = [];

  for (const [index, chunk] of chunks.entries()) {
    log.step(`extraindo chunk ${index + 1}/${chunks.length}: "${chunk.sectionTitle}"`);
    const existingIds = merged.map((requirement) => requirement.id);
    const request = buildExtractRequest(chunk, existingIds);
    const extracted = await aiClient.complete(request, RequirementArraySchema);
    merged.push(...ensureUniqueIds(extracted, new Set(existingIds)));
  }

  return dedupeRequirements(merged, aiClient);
}

/**
 * Modelos pequenos ignoram a lista de "IDs já usados" e recomeçam em REQ-1 a cada chunk;
 * ids repetidos quebram o plano de sprints e a rastreabilidade, então renumeramos aqui e
 * reescrevemos as dependências internas ao chunk.
 */
export function ensureUniqueIds(extracted: Requirement[], usedIds: Set<string>): Requirement[] {
  let next = nextRequirementNumber(usedIds);
  const renamed = new Map<string, string>();

  const withIds = extracted.map((requirement) => {
    if (!usedIds.has(requirement.id) && /^REQ-\d+$/.test(requirement.id)) {
      usedIds.add(requirement.id);
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
    dependencies: requirement.dependencies.map((depId) => renamed.get(depId) ?? depId),
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
  aiClient: ResilientAIClient,
): Promise<Requirement[]> {
  const pairs = findSimilarPairs(
    requirements,
    (requirement) => requirement.title,
    DEDUPE_SIMILARITY_THRESHOLD,
  );
  log.step(`${requirements.length} requisito(s) extraído(s); ${pairs.length} par(es) similares para confirmar`);

  const idsToRemove = new Set<string>();
  for (const pair of pairs) {
    if (idsToRemove.has(pair.a.id) || idsToRemove.has(pair.b.id)) continue;
    const request = buildDedupeConfirmRequest(pair.a, pair.b);
    const confirmation = await aiClient.complete(request, DedupeConfirmSchema);
    if (confirmation.same) {
      idsToRemove.add(pair.b.id);
    }
  }

  return requirements.filter((requirement) => !idsToRemove.has(requirement.id));
}
