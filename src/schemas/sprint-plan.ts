import { z } from 'zod';

export const SprintSchema = z.object({
  number: z.number().int().positive(),
  goal: z.string(),
  requirementIds: z.array(z.string()),
});
export type Sprint = z.infer<typeof SprintSchema>;

export const SprintPlanSchema = z.object({
  sprints: z.array(SprintSchema),
});
export type SprintPlan = z.infer<typeof SprintPlanSchema>;
