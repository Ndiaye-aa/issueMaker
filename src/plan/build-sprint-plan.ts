import type { ResilientAIClient } from '../ai/client.js';
import { buildPlanRequest } from '../ai/prompts/plan.js';
import type { Requirement } from '../schemas/requirement.js';
import { SprintPlanSchema, type SprintPlan } from '../schemas/sprint-plan.js';
import { validateAndFixSprintPlan } from './validate-sprint-plan.js';

export async function buildSprintPlan(
  requirements: Requirement[],
  sprintLength: string,
  aiClient: ResilientAIClient,
): Promise<SprintPlan> {
  const request = buildPlanRequest(requirements, sprintLength);
  const rawPlan = await aiClient.complete(request, SprintPlanSchema);
  return validateAndFixSprintPlan(requirements, rawPlan);
}
