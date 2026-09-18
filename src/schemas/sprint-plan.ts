import { z } from 'zod';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const SprintSchema = z.object({
  number: z.number().int().positive(),
  goal: z.string(),
  requirementIds: z.array(z.string()),
  /** Janela temporal do sprint (YYYY-MM-DD), calculada a partir de --start-date e --sprint-length. */
  startDate: z.string().regex(ISO_DATE_REGEX).optional(),
  dueDate: z.string().regex(ISO_DATE_REGEX).optional(),
});
export type Sprint = z.infer<typeof SprintSchema>;

export const SprintPlanSchema = z.object({
  sprints: z.array(SprintSchema),
  /** Sinais de alerta da auditoria do plano (ver src/plan/audit-sprint-plan.ts). */
  warnings: z.array(z.string()).optional(),
});
export type SprintPlan = z.infer<typeof SprintPlanSchema>;

/** Resposta da IA ao planejar: só a alocação; datas e avisos são calculados localmente. */
export const SprintPlanDraftSchema = z.object({
  sprints: z.array(
    z.object({
      number: z.number().int().positive(),
      goal: z.string(),
      requirementIds: z.array(z.string()),
    }),
  ),
});
