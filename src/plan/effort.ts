import type { Effort, Requirement } from '../schemas/requirement.js';

/** Pontos por tamanho de camiseta (Fibonacci truncado): a base do esforço ponderado. */
export const EFFORT_POINTS: Record<Effort, number> = { xs: 1, s: 2, m: 3, l: 5, xl: 8 };

export function pointsOf(requirement: Pick<Requirement, 'effort'>): number {
  return EFFORT_POINTS[requirement.effort];
}

export function totalPoints(requirements: Pick<Requirement, 'effort'>[]): number {
  return requirements.reduce((sum, requirement) => sum + pointsOf(requirement), 0);
}

export interface SprintCapacity {
  /** Capacidade nominal por sprint, em pontos. */
  nominal: number;
  /** Fração da capacidade nominal efetivamente planejada (buffer para imprevistos). */
  buffer: number;
}

/** Capacidade efetiva (nominal × buffer), nunca menor que 1 ponto. */
export function effectiveCapacity(capacity: SprintCapacity): number {
  return Math.max(1, Math.floor(capacity.nominal * capacity.buffer));
}

export function minimumSprints(requirements: Pick<Requirement, 'effort'>[], capacityPoints: number): number {
  if (requirements.length === 0) return 0;
  return Math.max(1, Math.ceil(totalPoints(requirements) / Math.max(1, capacityPoints)));
}

/** Teto rígido de sprints: nunca mais que isso, mesmo com capacidade insuficiente. */
export const MAX_SPRINTS = 12;

export interface SprintLimits {
  maxPerSprint?: number | undefined;
  capacityPoints?: number | undefined;
}

/**
 * Eleva capacityPoints/maxPerSprint o suficiente para que o volume total caiba em
 * `maxSprints`, distribuindo o excedente proporcionalmente entre todas as sprints em vez de
 * só estourar a última. Limites não informados (undefined) continuam sem ajuste.
 */
export function clampLimitsForMaxSprints(
  requirements: Pick<Requirement, 'effort'>[],
  limits: SprintLimits,
  maxSprints: number = MAX_SPRINTS,
): SprintLimits {
  if (requirements.length === 0) return limits;
  const capacityPoints =
    limits.capacityPoints === undefined
      ? undefined
      : Math.max(limits.capacityPoints, Math.ceil(totalPoints(requirements) / maxSprints));
  const maxPerSprint =
    limits.maxPerSprint === undefined
      ? undefined
      : Math.max(limits.maxPerSprint, Math.ceil(requirements.length / maxSprints));
  return { maxPerSprint, capacityPoints };
}
