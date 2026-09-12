import { z } from 'zod';

export const BacklogItemTypeSchema = z.enum(['feature', 'bug', 'tech-debt']);
export type BacklogItemType = z.infer<typeof BacklogItemTypeSchema>;

export const BacklogLayerSchema = z.enum(['frontend', 'backend']);
export type BacklogLayer = z.infer<typeof BacklogLayerSchema>;

export const BacklogItemSchema = z
  .object({
    id: z.string(),
    epic: z.string(),
    type: BacklogItemTypeSchema,
    title: z.string(),
    description: z.string(),
    expectedBehavior: z.string(),
    reproSteps: z.array(z.string()).optional(),
    environment: z.string().optional(),
    acceptanceCriteria: z.array(z.string()),
    labels: z.array(z.string()),
    sprint: z.number().int().positive(),
    layer: BacklogLayerSchema,
    /** Rastreabilidade até requirements.json (Seção 10 do SDD: NFR "Rastreabilidade"). */
    requirementIds: z.array(z.string()),
  })
  .refine((item) => item.type !== 'bug' || (item.reproSteps?.length ?? 0) > 0, {
    message: 'reproSteps é obrigatório quando type === "bug"',
    path: ['reproSteps'],
  });
export type BacklogItem = z.infer<typeof BacklogItemSchema>;

export const BacklogItemArraySchema = z.array(BacklogItemSchema);
