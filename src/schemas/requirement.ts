import { z } from 'zod';

export const LayerSchema = z.enum(['frontend', 'backend', 'shared']);
export type Layer = z.infer<typeof LayerSchema>;

/**
 * Esforço estimado na extração (escala de camiseta). O planejamento converte em pontos
 * (ver src/plan/effort.ts) para calcular quantos sprints cabem na capacidade.
 * Default "m" só para requirements.json gerados antes de o campo existir.
 */
export const EffortSchema = z.enum(['xs', 's', 'm', 'l', 'xl']);
export type Effort = z.infer<typeof EffortSchema>;

export const RequirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  layer: LayerSchema,
  priority: z.enum(['must', 'should', 'could']),
  effort: EffortSchema.default('m'),
  dependencies: z.array(z.string()),
  sourceSection: z.string(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const RequirementArraySchema = z.array(RequirementSchema);
