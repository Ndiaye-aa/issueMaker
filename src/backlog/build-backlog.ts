import type { ResilientAIClient } from '../ai/client.js';
import { buildBacklogRequest } from '../ai/prompts/backlog.js';
import { log } from '../cli/logger.js';
import {
  BacklogItemArraySchema,
  BacklogItemDraftArraySchema,
  type BacklogItem,
  type BacklogItemDraft,
} from '../schemas/backlog-item.js';
import { resolvePriority } from './priority.js';
import type { Requirement } from '../schemas/requirement.js';
import type { SprintPlan } from '../schemas/sprint-plan.js';

// Respostas curtas: menos risco de corte/loop em modelos locais e progresso visível.
const MAX_REQUIREMENTS_PER_BATCH = 20;

export async function buildBacklogForLayer(
  layer: 'frontend' | 'backend',
  requirements: Requirement[],
  sprintPlan: SprintPlan,
  aiClient: ResilientAIClient,
): Promise<BacklogItem[]> {
  const drafts: BacklogItemDraft[] = [];

  for (const sprint of sprintPlan.sprints) {
    const scoped = requirements.filter(
      (requirement) =>
        requirement.layer === layer && sprint.requirementIds.includes(requirement.id),
    );
    if (scoped.length === 0) continue;

    const batches = chunkArray(scoped, MAX_REQUIREMENTS_PER_BATCH);
    for (const [batchIndex, batchRequirements] of batches.entries()) {
      const batchLabel = batches.length > 1 ? ` lote ${batchIndex + 1}/${batches.length}` : '';
      log.step(
        `backlog ${layer}: sprint ${sprint.number}${batchLabel} (${batchRequirements.length} requisito(s))`,
      );
      const request = buildBacklogRequest(layer, batchRequirements, sprint);
      const batch = await aiClient.complete(request, BacklogItemDraftArraySchema);
      drafts.push(...batch.map((draft) => ({ ...draft, sprint: sprint.number })));
    }
  }

  const items = drafts.map((draft, index) => ({
    ...draft,
    id: `BL-${String(index + 1).padStart(3, '0')}`,
    priority: resolvePriority(draft.requirementIds, requirements),
  }));

  return BacklogItemArraySchema.parse(items);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
