import type { Requirement } from '../schemas/requirement.js';
import type { SprintPlan } from '../schemas/sprint-plan.js';
import { MAX_SPRINTS, pointsOf } from './effort.js';
import { isSetupRequirement } from './setup-requirement.js';

export const UNPLANNED_SPRINT_GOAL = 'Requisitos não alocados pelo plano';

export interface ValidateOptions {
  /** Teto de requisitos por sprint (contagem). */
  maxPerSprint?: number | undefined;
  /** Capacidade efetiva por sprint, em pontos de esforço. */
  capacityPoints?: number | undefined;
}

export interface RebalanceLimits {
  maxPerSprint?: number | undefined;
  capacityPoints?: number | undefined;
}

const PRIORITY_RANK: Record<Requirement['priority'], number> = { must: 3, should: 2, could: 1 };

/**
 * Garante que nenhum requisito esteja em um sprint anterior ao de qualquer requisito do
 * qual dependa. Reordena automaticamente (empurrando o requisito para o sprint da
 * dependência) quando a IA viola essa regra. Também descarta ids que não existem e
 * coloca num sprint final os requisitos que o modelo esqueceu de alocar, para que
 * nenhum suma do backlog. Com `maxPerSprint`, sprints acima da capacidade transbordam
 * para o seguinte (ver `rebalanceSprints`).
 */
export function validateAndFixSprintPlan(
  requirements: Requirement[],
  plan: SprintPlan,
  options: ValidateOptions = {},
): SprintPlan {
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

  let result: SprintPlan = { sprints };
  if (options.maxPerSprint !== undefined || options.capacityPoints !== undefined) {
    // Primeiro puxa por dependência, sem limite (nenhum requisito fica órfão numa sprint
    // tardia só porque a de destino já estava no teto); só depois o excedente de cada
    // sprint é redistribuído respeitando a capacidade, preservando o tamanho normal delas.
    const pulled = pullForward(requirements, result);
    result = rebalanceSprints(requirements, pulled, options);
    result = restoreMatchingGoals(result, plan);
  }
  return capSprintCount(renumberSprints(result), MAX_SPRINTS);
}

/**
 * Rede de segurança: garante no máximo `maxSprints` sprints mesmo se `clampLimitsForMaxSprints`
 * (chamado antes, em build-sprint-plan.ts) não tiver sido suficiente — ex.: cadeias de
 * dependência que forcem mais sprints, ou chamada direta desta função sem os limites já
 * ajustados. Funde todo o excedente no último sprint permitido, na ordem em que apareciam
 * (preserva a ordem de dependências); se isso estourar a capacidade, a auditoria já existente
 * (audit-sprint-plan.ts) avisa.
 */
export function capSprintCount(plan: SprintPlan, maxSprints: number): SprintPlan {
  if (plan.sprints.length <= maxSprints) return plan;
  const kept = plan.sprints.slice(0, maxSprints - 1);
  const overflow = plan.sprints.slice(maxSprints - 1);
  const merged = {
    number: maxSprints,
    goal: overflow[0]!.goal,
    requirementIds: overflow.flatMap((sprint) => sprint.requirementIds),
  };
  return { ...plan, sprints: [...kept, merged] };
}

interface Limits {
  maxPerSprint: number;
  capacityPoints: number;
}

function normalizeLimits(limits: RebalanceLimits | number): Limits {
  const raw = typeof limits === 'number' ? { maxPerSprint: limits } : limits;
  const valid = (value: number | undefined) => (Number.isInteger(value) && (value as number) >= 1 ? (value as number) : Infinity);
  return { maxPerSprint: valid(raw.maxPerSprint), capacityPoints: valid(raw.capacityPoints) };
}

function sprintPoints(ids: string[], byId: Map<string, Requirement>): number {
  return ids.reduce((sum, id) => {
    const requirement = byId.get(id);
    return sum + (requirement ? pointsOf(requirement) : 0);
  }, 0);
}

function exceedsLimits(ids: string[], byId: Map<string, Requirement>, limits: Limits): boolean {
  return ids.length > limits.maxPerSprint || sprintPoints(ids, byId) > limits.capacityPoints;
}

/**
 * Modelos tendem a despejar tudo no sprint 1. Aqui o excedente de cada sprint transborda
 * para o seguinte (criando novos sprints no fim se preciso), sem quebrar dependências:
 * quem é empurrado leva junto os requisitos do mesmo sprint que dependem dele. A escolha
 * de quem sai primeiro é determinística: menor prioridade, depois quem ninguém depende,
 * depois quem foi listado por último. Uma sprint excede quando passa do teto de itens
 * OU da capacidade em pontos; um requisito sozinho acima da capacidade fica onde está
 * (nunca some — a auditoria avisa).
 */
export function rebalanceSprints(
  requirements: Requirement[],
  plan: SprintPlan,
  limits: RebalanceLimits | number,
): SprintPlan {
  const normalized = normalizeLimits(limits);
  if (normalized.maxPerSprint === Infinity && normalized.capacityPoints === Infinity) return plan;

  const byId = new Map(requirements.map((r) => [r.id, r]));
  const dependentsById = new Map<string, string[]>();
  for (const requirement of requirements) {
    for (const depId of requirement.dependencies) {
      dependentsById.set(depId, [...(dependentsById.get(depId) ?? []), requirement.id]);
    }
  }

  const sprints = plan.sprints.map((sprint) => ({ ...sprint, requirementIds: [...sprint.requirementIds] }));

  for (let index = 0; index < sprints.length; index += 1) {
    const sprint = sprints[index]!;
    while (sprint.requirementIds.length > 1 && exceedsLimits(sprint.requirementIds, byId, normalized)) {
      const inSprint = new Set(sprint.requirementIds);
      const candidate = pickOverflowCandidate(sprint.requirementIds, byId, dependentsById, inSprint);
      const moving = collectWithDependents(candidate, dependentsById, inSprint);

      sprint.requirementIds = sprint.requirementIds.filter((id) => !moving.has(id));
      const next = sprints[index + 1] ?? appendSprint(sprints, sprint.number + 1);
      // Os movidos entram na frente do destino: itens já lá podem depender deles.
      next.requirementIds = [...moving, ...next.requirementIds];
    }
  }

  return { sprints: sprints.filter((sprint) => sprint.requirementIds.length > 0) };
}

/**
 * "must" o mais cedo possível: percorre as sprints em ordem e puxa de sprints posteriores
 * os requisitos must (depois should) cujas dependências já estão em sprints anteriores ou
 * na própria. Ordem estável: sprint de origem, depois posição. Evita a sprint "só de could"
 * enquanto há must pendente mais adiante.
 *
 * Não é limitado por capacidade/teto de itens: perder a alocação mais cedo possível (e por
 * tabela, deixar um requisito sem dependência pendente preso numa sprint tardia só porque a
 * anterior já estava no teto) é pior do que a sprint ficar temporariamente acima da
 * capacidade nominal. `auditSprintPlan` (audit-sprint-plan.ts) já avisa quando isso acontece.
 */
export function pullForward(requirements: Requirement[], plan: SprintPlan): SprintPlan {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const sprints = plan.sprints.map((sprint) => ({ ...sprint, requirementIds: [...sprint.requirementIds] }));

  for (let index = 0; index < sprints.length; index += 1) {
    const target = sprints[index]!;
    const settled = new Set(sprints.slice(0, index + 1).flatMap((s) => s.requirementIds));

    // Tarefas de setup (scaffolding/infra/deploy) vão para a frente de tudo o mais, antes até
    // de outros "must": nada depende delas, raramente têm dependência própria, e são elas que
    // o time normalmente precisa resolver primeiro para o resto poder rodar.
    for (let later = index + 1; later < sprints.length; later += 1) {
      const source = sprints[later]!;
      for (const id of [...source.requirementIds]) {
        const requirement = byId.get(id);
        if (!requirement || !isSetupRequirement(requirement)) continue;
        if (!requirement.dependencies.every((dep) => settled.has(dep) || !byId.has(dep))) continue;
        target.requirementIds = [id, ...target.requirementIds];
        source.requirementIds = source.requirementIds.filter((other) => other !== id);
        settled.add(id);
      }
    }

    for (const priority of ['must', 'should'] as const) {
      for (let later = index + 1; later < sprints.length; later += 1) {
        const source = sprints[later]!;
        for (const id of [...source.requirementIds]) {
          const requirement = byId.get(id);
          if (!requirement || requirement.priority !== priority) continue;
          if (isSetupRequirement(requirement)) continue; // já tratado no passo acima
          if (!requirement.dependencies.every((dep) => settled.has(dep) || !byId.has(dep))) continue;
          target.requirementIds = [...target.requirementIds, id];
          source.requirementIds = source.requirementIds.filter((other) => other !== id);
          settled.add(id);
        }
      }
    }
  }

  return { sprints: sprints.filter((sprint) => sprint.requirementIds.length > 0) };
}

/**
 * O pull-forward pode esvaziar uma sprint original (some do array) e o rebalanceamento
 * recriar uma sprint do zero para acomodar o que transbordou de volta (`appendSprint`, goal
 * genérico "Sprint N") — mesmo quando o conjunto de requisitos que ela acaba recebendo é
 * idêntico ao de alguma sprint do plano original. Sem isso, `sprintsWithChangedComposition`
 * (build-sprint-plan.ts) não pede um goal novo (a composição bate com a original), e a sprint
 * fica com o texto genérico em vez do goal que a IA já tinha escrito para aquele conjunto.
 */
function restoreMatchingGoals(result: SprintPlan, originalPlan: SprintPlan): SprintPlan {
  const goalByComposition = new Map(
    originalPlan.sprints.map((sprint) => [[...sprint.requirementIds].sort().join('|'), sprint.goal]),
  );
  return {
    ...result,
    sprints: result.sprints.map((sprint) => {
      const goal = goalByComposition.get([...sprint.requirementIds].sort().join('|'));
      return goal === undefined ? sprint : { ...sprint, goal };
    }),
  };
}

/** Sprints contíguos a partir de 1 (sprints esvaziadas pelo rebalanceamento somem). */
export function renumberSprints(plan: SprintPlan): SprintPlan {
  return {
    ...plan,
    sprints: plan.sprints.map((sprint, index) => ({ ...sprint, number: index + 1 })),
  };
}

function appendSprint(sprints: SprintPlan['sprints'], number: number): SprintPlan['sprints'][number] {
  const sprint = { number, goal: `Sprint ${number}`, requirementIds: [] as string[] };
  sprints.push(sprint);
  return sprint;
}

function pickOverflowCandidate(
  ids: string[],
  byId: Map<string, Requirement>,
  dependentsById: Map<string, string[]>,
  inSprint: Set<string>,
): string {
  let best: { id: string; key: [number, number, number, number] } | undefined;
  ids.forEach((id, position) => {
    const requirement = byId.get(id);
    const priority = requirement?.priority ?? 'should';
    // Tarefa de setup nunca transborda antes de tudo o mais no lote (só se sobrar só setup):
    // é o componente mais significativo, comparado antes até da prioridade.
    const setupRank = requirement && isSetupRequirement(requirement) ? 1 : 0;
    const dependentsInSprint = (dependentsById.get(id) ?? []).filter((dep) => inSprint.has(dep)).length;
    const key: [number, number, number, number] = [setupRank, PRIORITY_RANK[priority], dependentsInSprint, -position];
    if (best === undefined || compareKeys(key, best.key) < 0) {
      best = { id, key };
    }
  });
  return best!.id;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function collectWithDependents(
  root: string,
  dependentsById: Map<string, string[]>,
  inSprint: Set<string>,
): Set<string> {
  const moving = new Set<string>([root]);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const dependent of dependentsById.get(current) ?? []) {
      if (inSprint.has(dependent) && !moving.has(dependent)) {
        moving.add(dependent);
        stack.push(dependent);
      }
    }
  }
  return moving;
}
