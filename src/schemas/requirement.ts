import { z } from 'zod';

export const LayerSchema = z.enum(['frontend', 'backend', 'shared']);
export type Layer = z.infer<typeof LayerSchema>;

export const RequirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  layer: LayerSchema,
  priority: z.enum(['must', 'should', 'could']),
  dependencies: z.array(z.string()),
  sourceSection: z.string(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const RequirementArraySchema = z.array(RequirementSchema);
