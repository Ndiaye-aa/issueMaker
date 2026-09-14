import type { AIClient } from '../ai/provider.js';
import { buildPlanRequest } from '../ai/prompts/plan.js';
import { buildSprintGoalsRequest, SprintGoalsSchema } from '../ai/prompts/sprint-goals.js';
import { log } from '../cli/logger.js';
import type { Requirement } from '../schemas/requirement.js';
import { SprintPlanDraftSchema, type SprintPlan } from '../schemas/sprint-plan.js';
import { auditSprintPlan, formatSprintSummary, sprintLoads } from './audit-sprint-plan.js';
import { clampLimitsForMaxSprints, effectiveCapacity, MAX_SPRINTS, type SprintCapacity } from './effort.js';
import { assignSprintDates, parseSprintLengthDays } from './sprint-dates.js';
import { validateAndFixSprintPlan } from './validate-sprint-plan.js';

export interface SprintPlanOptions {
  /** Teto de requisitos por sprint (contagem); o excedente é redistribuído deterministicamente. */
  maxPerSprint?: number | undefined;
  /** Capacidade por sprint em pontos de esforço + buffer. Sem valor, só o teto de contagem vale. */
  capacity?: SprintCapacity | undefined;
  /** Data de início do sprint 1 (YYYY-MM-DD). Sem valor, o plano sai sem datas. */
  startDate?: string | undefined;
}

export async function buildSprintPlan(
  requirements: Requirement[],
  sprintLength: string,
  aiClient: AIClient,
  options: SprintPlanOptions = {},
): Promise<SprintPlan> {
  const rawCapacityPoints = options.capacity ? effectiveCapacity(options.capacity) : undefined;
  const { capacityPoints, maxPerSprint } = clampLimitsForMaxSprints(requirements, {
    capacityPoints: rawCapacityPoints,
    maxPerSprint: options.maxPerSprint,
  });
  if (capacityPoints !== rawCapacityPoints || maxPerSprint !== options.maxPerSprint) {
    log.step(
      `limites ajustados para caber em no máximo ${MAX_SPRINTS} sprints: capacidade ${rawCapacityPoints ?? '—'} → ${capacityPoints ?? '—'} pts, teto ${options.maxPerSprint ?? '—'} → ${maxPerSprint ?? '—'} itens`,
    );
  }
  const request = buildPlanRequest(requirements, sprintLength, {
    capacityPoints,
    maxPerSprint,
  });
  const rawPlan = await aiClient.complete(request, SprintPlanDraftSchema);
  let plan = validateAndFixSprintPlan(requirements, rawPlan, {
    maxPerSprint,
    capacityPoints,
  });
  if (plan.sprints.length !== rawPlan.sprints.length) {
    log.step(
      `plano ajustado: ${rawPlan.sprints.length} sprint(s) propostos pelo modelo → ${plan.sprints.length} após validação/capacidade`,
    );
  }

  const changed = sprintsWithChangedComposition(rawPlan, plan);
  if (changed.length > 0) {
    log.step(`reescrevendo goals de ${changed.length} sprint(s) cuja composição mudou`);
    plan = await rewriteGoals(plan, changed, requirements, aiClient);
  }

  const days = parseSprintLengthDays(sprintLength);
  if (options.startDate !== undefined) {
    if (days === undefined) {
      log.warn(`não reconheci a duração "${sprintLength}" (use ex.: "2 semanas", "10 dias"); o plano sai sem datas.`);
    } else {
      plan = assignSprintDates(plan, options.startDate, days);
    }
  }

  const warnings = auditSprintPlan(plan, requirements, capacityPoints);
  for (const load of sprintLoads(plan, requirements)) {
    log.step(formatSprintSummary(load, capacityPoints));
  }
  for (const warning of warnings) log.warn(warning);

  return warnings.length > 0 ? { ...plan, warnings } : plan;
}

/** Números dos sprints (do plano final) cujo conjunto de requisitos difere do proposto pela IA. */
function sprintsWithChangedComposition(rawPlan: SprintPlan, plan: SprintPlan): number[] {
  const rawKeys = new Set(rawPlan.sprints.map((s) => [...s.requirementIds].sort().join('|')));
  return plan.sprints
    .filter((sprint) => !rawKeys.has([...sprint.requirementIds].sort().join('|')))
    .map((sprint) => sprint.number);
}

async function rewriteGoals(
  plan: SprintPlan,
  numbers: number[],
  requirements: Requirement[],
  aiClient: AIClient,
): Promise<SprintPlan> {
  const targets = plan.sprints.filter((sprint) => numbers.includes(sprint.number));
  const response = await aiClient.complete(buildSprintGoalsRequest(targets, requirements), SprintGoalsSchema);
  const goalByNumber = new Map(response.goals.map((entry) => [entry.number, entry.goal]));
  return {
    ...plan,
    sprints: plan.sprints.map((sprint) => {
      const goal = goalByNumber.get(sprint.number);
      return goal ? { ...sprint, goal } : sprint;
    }),
  };
}
