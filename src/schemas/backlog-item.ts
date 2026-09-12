import { z } from 'zod';

export const BacklogItemTypeSchema = z.enum(['feature', 'bug', 'tech-debt']);
export type BacklogItemType = z.infer<typeof BacklogItemTypeSchema>;

export const BacklogLayerSchema = z.enum(['frontend', 'backend']);
export type BacklogLayer = z.infer<typeof BacklogLayerSchema>;

export const BacklogPrioritySchema = z.enum(['must', 'should', 'could']);
export type BacklogPriority = z.infer<typeof BacklogPrioritySchema>;

const backlogItemShape = {
  id: z.string(),
  epic: z.string(),
  type: BacklogItemTypeSchema,
  title: z.string().min(10, 'title deve ser específico, não genérico'),
  description: z.string().min(15, 'description deve ser objetiva e detalhada'),
  expectedBehavior: z.string().min(10, 'expectedBehavior é obrigatório e não pode ser vago'),
  reproSteps: z.array(z.string().min(1)).optional(),
  environment: z.string().optional(),
  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1, 'acceptanceCriteria não pode ser vazio: defina ao menos um critério testável'),
  labels: z.array(z.string()),
  sprint: z.number().int().positive(),
  layer: BacklogLayerSchema,
  /** Rastreabilidade até requirements.json (Seção 10 do SDD: NFR "Rastreabilidade"). */
  requirementIds: z.array(z.string()),
};

const REPRO_STEPS_ISSUE = {
  message: 'reproSteps é obrigatório quando type === "bug"',
  path: ['reproSteps'],
};

/**
 * Schema do JSON bruto retornado pela IA (comando `backlog`): sem "priority", que é
 * calculado deterministicamente depois, a partir dos requirements de origem (ver
 * src/backlog/priority.ts), nunca gerado pelo modelo.
 */
export const BacklogItemDraftSchema = z
  .object(backlogItemShape)
  .refine((item) => item.type !== 'bug' || (item.reproSteps?.length ?? 0) > 0, REPRO_STEPS_ISSUE);
export type BacklogItemDraft = z.infer<typeof BacklogItemDraftSchema>;

export const BacklogItemDraftArraySchema = z.array(BacklogItemDraftSchema);

export const BacklogItemSchema = z
  .object({
    ...backlogItemShape,
    priority: BacklogPrioritySchema,
  })
  .refine((item) => item.type !== 'bug' || (item.reproSteps?.length ?? 0) > 0, REPRO_STEPS_ISSUE);
export type BacklogItem = z.infer<typeof BacklogItemSchema>;

export const BacklogItemArraySchema = z.array(BacklogItemSchema);
