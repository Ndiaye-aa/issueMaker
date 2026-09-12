import type { Requirement } from '../schemas/requirement.js';
import type { SprintPlan } from '../schemas/sprint-plan.js';

/**
 * Garante que nenhum requisito esteja em um sprint anterior ao de qualquer requisito do
 * qual dependa. Reordena automaticamente (empurrando o requisito para o sprint da
 * dependência) quando a IA viola essa regra.
 */
export function validateAndFixSprintPlan(requirements: Requirement[], plan: SprintPlan): SprintPlan {
  const sprintByReqId = new Map<string, number>();
  for (const sprint of plan.sprints) {
    for (const reqId of sprint.requirementIds) {
      sprintByReqId.set(reqId, sprint.number);
    }
  }

  const dependenciesById = new Map(requirements.map((r) => [r.id, r.dependencies]));

  let changed = true;
  let iterations = 0;
  const maxIterations = requirements.length + 1;
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations += 1;
    for (const [reqId, currentSprint] of sprintByReqId) {
      for (const depId of dependenciesById.get(reqId) ?? []) {
        const depSprint = sprintByReqId.get(depId);
        if (depSprint !== undefined && depSprint > (sprintByReqId.get(reqId) ?? currentSprint)) {
          sprintByReqId.set(reqId, depSprint);
          changed = true;
        }
      }
    }
  }

  const goalByNumber = new Map(plan.sprints.map((s) => [s.number, s.goal]));
  const groups = new Map<number, string[]>();
  for (const [reqId, sprintNumber] of sprintByReqId) {
    const list = groups.get(sprintNumber) ?? [];
    list.push(reqId);
    groups.set(sprintNumber, list);
  }

  const sprints = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, requirementIds]) => ({
      number,
      goal: goalByNumber.get(number) ?? `Sprint ${number}`,
      requirementIds,
    }));

  return { sprints };
}
