import type { Requirement } from '../schemas/requirement.js';
import type { SprintPlan } from '../schemas/sprint-plan.js';

export const UNPLANNED_SPRINT_GOAL = 'Requisitos não alocados pelo plano';

/**
 * Garante que nenhum requisito esteja em um sprint anterior ao de qualquer requisito do
 * qual dependa. Reordena automaticamente (empurrando o requisito para o sprint da
 * dependência) quando a IA viola essa regra. Também descarta ids que não existem e
 * coloca num sprint final os requisitos que o modelo esqueceu de alocar, para que
 * nenhum suma do backlog.
 */
export function validateAndFixSprintPlan(requirements: Requirement[], plan: SprintPlan): SprintPlan {
  const knownIds = new Set(requirements.map((r) => r.id));
  const sprintByReqId = new Map<string, number>();
  for (const sprint of plan.sprints) {
    for (const reqId of sprint.requirementIds) {
      if (knownIds.has(reqId) && !sprintByReqId.has(reqId)) {
        sprintByReqId.set(reqId, sprint.number);
      }
    }
  }

  const unplanned = requirements.filter((r) => !sprintByReqId.has(r.id));
  const unplannedSprint = Math.max(0, ...plan.sprints.map((s) => s.number)) + 1;
  for (const requirement of unplanned) {
    sprintByReqId.set(requirement.id, unplannedSprint);
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
  if (unplanned.length > 0) goalByNumber.set(unplannedSprint, UNPLANNED_SPRINT_GOAL);
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
