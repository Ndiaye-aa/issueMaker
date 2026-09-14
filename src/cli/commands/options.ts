import { isIsoDate, parseSprintLengthDays, todayIsoDate } from '../../plan/sprint-dates.js';
import type { SprintCapacity } from '../../plan/effort.js';

export const DEFAULT_MAX_PER_SPRINT = 20;
export const DEFAULT_BUFFER = 0.75;

export function parseMaxPerSprint(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--max-per-sprint inválido: "${raw}". Use um inteiro maior que zero.`);
  }
  return value;
}

export function parseStartDate(raw: string | undefined): string {
  const value = raw ?? todayIsoDate();
  if (!isIsoDate(value)) {
    throw new Error(`--start-date inválida: "${raw}". Use o formato YYYY-MM-DD.`);
  }
  return value;
}

/**
 * Capacidade nominal por sprint em pontos de esforço. Sem `--capacity`, assume 1 ponto por
 * dia da duração do sprint ("2 semanas" → 14). Sem duração reconhecível, sem capacidade.
 */
export function parseCapacity(
  rawCapacity: string | undefined,
  rawBuffer: string | undefined,
  sprintLength: string,
): SprintCapacity | undefined {
  const buffer = rawBuffer === undefined ? DEFAULT_BUFFER : Number(rawBuffer);
  if (!Number.isFinite(buffer) || buffer <= 0 || buffer > 1) {
    throw new Error(`--buffer inválido: "${rawBuffer}". Use uma fração entre 0 e 1 (ex.: 0.75).`);
  }
  if (rawCapacity !== undefined) {
    const nominal = Number(rawCapacity);
    if (!Number.isInteger(nominal) || nominal < 1) {
      throw new Error(`--capacity inválida: "${rawCapacity}". Use um inteiro de pontos maior que zero.`);
    }
    return { nominal, buffer };
  }
  const days = parseSprintLengthDays(sprintLength);
  return days === undefined ? undefined : { nominal: days, buffer };
}
