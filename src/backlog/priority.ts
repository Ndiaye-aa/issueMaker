import type { BacklogPriority } from '../schemas/backlog-item.js';
import type { Requirement } from '../schemas/requirement.js';

const PRIORITY_RANK: Record<Requirement['priority'], number> = {
  must: 3,
  should: 2,
  could: 1,
};

const DEFAULT_PRIORITY: BacklogPriority = 'should';

/**
 * Calcula a prioridade de um item de backlog a partir dos requisitos que o originaram,
 * em vez de confiar na IA para reportá-la: usa a mais alta entre os requisitos referenciados
 * (must > should > could), já que sub-priorizar algo derivado de um requisito "must" seria
 * pior do que super-priorizar um "could".
 */
export function resolvePriority(requirementIds: string[], requirements: Requirement[]): BacklogPriority {
  const matched = requirements.filter((requirement) => requirementIds.includes(requirement.id));
  if (matched.length === 0) {
    return DEFAULT_PRIORITY;
  }

  return matched.reduce<BacklogPriority>(
    (highest, requirement) =>
      PRIORITY_RANK[requirement.priority] > PRIORITY_RANK[highest] ? requirement.priority : highest,
    matched[0]!.priority,
  );
}
