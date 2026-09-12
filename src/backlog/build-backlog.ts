import type { ResilientAIClient } from '../ai/client.js';
import { buildBacklogRequest } from '../ai/prompts/backlog.js';
import { BacklogItemArraySchema, BacklogItemDraftArraySchema, type BacklogItem } from '../schemas/backlog-item.js';
import { resolvePriority } from './priority.js';
import type { Requirement } from '../schemas/requirement.js';
import type { SprintPlan } from '../schemas/sprint-plan.js';

export async function buildBacklogForLayer(
  layer: 'frontend' | 'backend',
  requirements: Requirement[],
  sprintPlan: SprintPlan,
  aiClient: ResilientAIClient,
): Promise<BacklogItem[]> {
  const request = buildBacklogRequest(layer, requirements, sprintPlan);
  const drafts = await aiClient.complete(request, BacklogItemDraftArraySchema);

  const items = drafts.map((draft) => ({
    ...draft,
    priority: resolvePriority(draft.requirementIds, requirements),
  }));

  return BacklogItemArraySchema.parse(items);
}
