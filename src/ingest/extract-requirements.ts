import type { ResilientAIClient } from '../ai/client.js';
import { buildExtractRequest } from '../ai/prompts/extract.js';
import { buildDedupeConfirmRequest, DedupeConfirmSchema } from '../ai/prompts/dedupe-confirm.js';
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

  for (const chunk of chunks) {
    const existingIds = merged.map((requirement) => requirement.id);
    const request = buildExtractRequest(chunk, existingIds);
    const extracted = await aiClient.complete(request, RequirementArraySchema);
    merged.push(...extracted);
  }

  return dedupeRequirements(merged, aiClient);
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
