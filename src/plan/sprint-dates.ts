import type { SprintPlan } from '../schemas/sprint-plan.js';

const SPRINT_LENGTH_REGEX = /(\d+)\s*(d|dia|dias|w|sem|semana|semanas)\b/i;
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Converte a duração livre informada em `--sprint-length` ("2 semanas", "10d") em dias.
 * Texto não reconhecido ("um mês") devolve undefined: o plano sai sem datas.
 */
export function parseSprintLengthDays(sprintLength: string): number | undefined {
  const match = SPRINT_LENGTH_REGEX.exec(sprintLength);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  if (!Number.isInteger(amount) || amount < 1) return undefined;
  return unit.startsWith('d') ? amount : amount * 7;
}

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE_REGEX.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return formatIsoDate(date) === value;
}

export function todayIsoDate(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

/**
 * Janelas sequenciais e sem sobreposição: o sprint k começa em startDate + (k-1)·days e
 * vence no último dia da janela. Usa a posição no plano (não o `number`), para que
 * sprints renumerados continuem contíguos.
 */
export function assignSprintDates(plan: SprintPlan, startDate: string, days: number): SprintPlan {
  if (!isIsoDate(startDate)) {
    throw new Error(`data inicial inválida: "${startDate}". Use o formato YYYY-MM-DD.`);
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`duração de sprint inválida: ${days} dia(s).`);
  }
  return {
    ...plan,
    sprints: plan.sprints.map((sprint, index) => {
      const sprintStart = addDays(startDate, index * days);
      return { ...sprint, startDate: sprintStart, dueDate: addDays(sprintStart, days - 1) };
    }),
  };
}
