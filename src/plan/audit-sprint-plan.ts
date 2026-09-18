import type { Requirement } from '../schemas/requirement.js';
import type { SprintPlan } from '../schemas/sprint-plan.js';
import { GENERIC_GOAL_REGEX } from '../ai/prompts/sprint-goals.js';
import { pointsOf } from './effort.js';

export const IMBALANCE_MEAN_RATIO = 1.3;
export const IMBALANCE_SPREAD_RATIO = 0.5;
export const UNDERUSED_CAPACITY_RATIO = 0.3;

export interface SprintLoad {
  number: number;
  points: number;
  count: number;
}

export function sprintLoads(plan: SprintPlan, requirements: Requirement[]): SprintLoad[] {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  return plan.sprints.map((sprint) => ({
    number: sprint.number,
    count: sprint.requirementIds.length,
    points: sprint.requirementIds.reduce((sum, id) => {
      const requirement = byId.get(id);
      return sum + (requirement ? pointsOf(requirement) : 0);
    }, 0),
  }));
}

/**
 * Sinais de alerta de sprint mal planejada. Não altera o plano: devolve mensagens para
 * o usuário revisar (gravadas em sprint-plan.json e logadas). Cada aviso cita sprint,
 * ids e números para ser acionável.
 */
export function auditSprintPlan(
  plan: SprintPlan,
  requirements: Requirement[],
  capacityPoints?: number,
): string[] {
  const warnings: string[] = [];
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const loads = sprintLoads(plan, requirements);
  const sprintOf = new Map<string, number>();
  for (const sprint of plan.sprints) {
    for (const id of sprint.requirementIds) sprintOf.set(id, sprint.number);
  }

  for (const sprint of plan.sprints) {
    const goal = sprint.goal.trim();
    if (GENERIC_GOAL_REGEX.test(goal) || /^sprint\s+\d+$/i.test(goal)) {
      warnings.push(`Sprint ${sprint.number}: goal genérico ("${goal}") — sintoma de itens sem coesão temática; descreva o resultado demonstrável.`);
    }
  }

  if (loads.length > 1) {
    const max = Math.max(...loads.map((l) => l.points));
    const min = Math.min(...loads.map((l) => l.points));
    if (max > 0 && (max - min) / max > IMBALANCE_SPREAD_RATIO) {
      const fullest = loads.find((l) => l.points === max)!;
      const emptiest = loads.find((l) => l.points === min)!;
      warnings.push(`Carga desbalanceada: Sprint ${fullest.number} tem ${max} pts e Sprint ${emptiest.number} tem ${min} pts (diferença de ${Math.round(((max - min) / max) * 100)}%, acima de ${IMBALANCE_SPREAD_RATIO * 100}%).`);
    }
    for (const load of loads) {
      const others = loads.filter((l) => l.number !== load.number);
      const mean = others.reduce((sum, l) => sum + l.points, 0) / others.length;
      if (mean > 0 && load.points > mean * IMBALANCE_MEAN_RATIO) {
        warnings.push(`Sprint ${load.number}: ${load.points} pts, acima de ${IMBALANCE_MEAN_RATIO * 100}% da média das demais (${mean.toFixed(1)} pts).`);
      }
    }
  }

  if (capacityPoints !== undefined) {
    loads.forEach((load, index) => {
      if (load.points > capacityPoints) {
        const ids = plan.sprints[index]!.requirementIds.join(', ');
        warnings.push(`Sprint ${load.number}: sobrecarregada com ${load.points} pts para capacidade de ${capacityPoints} (${ids}).`);
      }
      const hasLaterSprint = index < loads.length - 1;
      if (hasLaterSprint && load.count === 1 && load.points < capacityPoints * UNDERUSED_CAPACITY_RATIO) {
        warnings.push(`Sprint ${load.number}: subutilizada — 1 item com ${load.points} pts para capacidade de ${capacityPoints}.`);
      }
    });
  }

  plan.sprints.forEach((sprint, index) => {
    const priorities = sprint.requirementIds.map((id) => byId.get(id)?.priority).filter(Boolean);
    const onlyCould = priorities.length > 0 && priorities.every((p) => p === 'could');
    if (!onlyCould) return;
    const pendingMust = plan.sprints
      .slice(index + 1)
      .flatMap((later) => later.requirementIds)
      .filter((id) => byId.get(id)?.priority === 'must')
      .filter((id) => {
        const deps = byId.get(id)?.dependencies ?? [];
        return deps.every((dep) => (sprintOf.get(dep) ?? 0) <= sprint.number);
      });
    if (pendingMust.length > 0) {
      warnings.push(`Sprint ${sprint.number}: só itens "could" enquanto há "must" pendente em sprint posterior sem dependência que justifique (${pendingMust.join(', ')}).`);
    }
  });

  for (const requirement of requirements) {
    const own = sprintOf.get(requirement.id);
    if (own === undefined) continue;
    for (const dep of requirement.dependencies) {
      const depSprint = sprintOf.get(dep);
      if (depSprint !== undefined && depSprint > own) {
        warnings.push(`Dependência violada: ${requirement.id} (Sprint ${own}) depende de ${dep} (Sprint ${depSprint}).`);
      }
    }
  }

  return warnings;
}

export function formatSprintSummary(load: SprintLoad, capacityPoints?: number): string {
  const capacity =
    capacityPoints === undefined
      ? `${load.points} pts`
      : `${load.points} pts / ${capacityPoints} (${Math.round((load.points / capacityPoints) * 100)}%)`;
  return `Sprint ${load.number}: ${capacity} — ${load.count} requisito(s)`;
}
