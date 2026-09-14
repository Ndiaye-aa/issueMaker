import { z } from 'zod';
import { backlogQualityRules } from './backlog-quality.js';

export const BacklogItemTypeSchema = z.enum(['feature', 'bug', 'tech-debt']);
export type BacklogItemType = z.infer<typeof BacklogItemTypeSchema>;

export const BacklogLayerSchema = z.enum(['frontend', 'backend']);
export type BacklogLayer = z.infer<typeof BacklogLayerSchema>;

export const BacklogPrioritySchema = z.enum(['must', 'should', 'could']);
export type BacklogPriority = z.infer<typeof BacklogPrioritySchema>;

/**
 * Bloco de especificidade técnica (Regra 4 do prompt de backlog): números e nomes reais em
 * vez de adjetivos, e sinalização explícita quando falta uma decisão técnica.
 */
export const TechnicalSpecificitySchema = z.object({
  httpCodes: z.array(z.string()).describe('Códigos de status HTTP citados no requisito (ex.: "200", "404"); [] se não houver.'),
  fields: z.array(z.string()).describe('Nomes de campos/endpoints/mensagens de erro específicos citados; [] se não houver.'),
  limits: z.string().nullable().describe('Limite numérico específico (tamanho, prazo, quantidade), ou null.'),
  needsClarification: z.boolean().describe('true quando o requisito original não dá informação suficiente para ser específico.'),
  clarificationNote: z.string().nullable().describe('Qual decisão técnica falta ser tomada, quando needsClarification é true; senão null.'),
});
export type TechnicalSpecificity = z.infer<typeof TechnicalSpecificitySchema>;

// Limites generosos, para os campos que a Regra de qualidade (backlog-quality.ts) não já
// limita: contêm respostas fora de controle sem gerar retry de schema por poucos caracteres.
// O tamanho de "title" já é imposto por TITLE_MAX_LENGTH em backlog-quality.ts (70 chars,
// com mensagem específica); repetir o limite aqui só duplicaria o erro.
const DESCRIPTION_MAX = 900;
const EXPECTED_BEHAVIOR_MAX = 500;
const CRITERION_MAX = 300;
const ACCEPTANCE_CRITERIA_MAX = 8;

/** Campos gerados pela IA, exatamente os do formato de saída do prompt. */
const aiGeneratedShape = {
  title: z
    .string()
    .min(10, 'title deve ser específico, não genérico')
    .describe('Verbo de ação no infinitivo + objeto específico + contexto se necessário. Até 70 caracteres.'),
  type: BacklogItemTypeSchema,
  description: z
    .string()
    .min(15, 'description deve ser objetiva e detalhada')
    .max(DESCRIPTION_MAX, `description deve ter no máximo ${DESCRIPTION_MAX} caracteres`)
    .describe('O mecanismo técnico — o que implementar ou o que está quebrado, não o efeito observável.'),
  expectedBehavior: z
    .string()
    .min(10, 'expectedBehavior é obrigatório e não pode ser vago')
    .max(EXPECTED_BEHAVIOR_MAX, `expectedBehavior deve ter no máximo ${EXPECTED_BEHAVIOR_MAX} caracteres`)
    .describe('Resultado observável, distinto da description.'),
  acceptanceCriteria: z
    .array(z.string().min(1).max(CRITERION_MAX, `cada critério deve ter no máximo ${CRITERION_MAX} caracteres`))
    .min(1, 'acceptanceCriteria não pode ser vazio: defina ao menos um critério testável')
    .max(ACCEPTANCE_CRITERIA_MAX, `acceptanceCriteria deve ter no máximo ${ACCEPTANCE_CRITERIA_MAX} critérios`)
    .describe('3 a 6 critérios testáveis ("Quando X, então Y"), cobrindo caminho de sucesso e casos negativos.'),
  reproSteps: z.array(z.string().min(1)).optional().describe('Passos para reproduzir; obrigatório apenas quando type é "bug".'),
  environment: z.string().optional().describe('SO/navegador/runtime/versão citados no requisito; omitir se o requisito não especificar.'),
};

const backlogItemShape = {
  id: z.string(),
  epic: z.string(),
  ...aiGeneratedShape,
  technicalSpecificity: TechnicalSpecificitySchema.optional(),
  labels: z.array(z.string()),
  sprint: z.number().int().positive(),
  layer: BacklogLayerSchema,
  /** Rastreabilidade até requirements.json (Seção 10 do SDD: NFR "Rastreabilidade"). */
  requirementIds: z.array(z.string()),
  /**
   * Ids de requisito (REQ-x, únicos no projeto) dos quais este item depende — derivados de
   * Requirement.dependencies, nunca do modelo. Viram "Depende de: #N" na issue publicada e
   * ditam a ordem topológica de publicação. Default para backlogs antigos.
   */
  dependsOn: z.array(z.string()).default([]),
};

const REPRO_STEPS_ISSUE = {
  message: 'reproSteps é obrigatório quando type === "bug"',
  path: ['reproSteps'],
};

const hasReproStepsWhenBug = (item: { type: string; reproSteps?: string[] | undefined }) =>
  item.type !== 'bug' || (item.reproSteps?.length ?? 0) > 0;

/**
 * Schema do JSON bruto retornado pela IA (comando `backlog`): um item por requisito, só com
 * os campos que o modelo gera. Sem "priority" (calculada a partir do requirement de origem),
 * sem ids/sprint/layer/epic (preenchidos localmente). Aplica as regras de qualidade do prompt.
 */
export const BacklogItemDraftSchema = z
  .object({
    ...aiGeneratedShape,
    technicalSpecificity: TechnicalSpecificitySchema,
  })
  .refine(hasReproStepsWhenBug, REPRO_STEPS_ISSUE)
  .superRefine(backlogQualityRules);
export type BacklogItemDraft = z.infer<typeof BacklogItemDraftSchema>;

export const BacklogItemSchema = z
  .object({
    ...backlogItemShape,
    priority: BacklogPrioritySchema,
  })
  .refine(hasReproStepsWhenBug, REPRO_STEPS_ISSUE);
export type BacklogItem = z.infer<typeof BacklogItemSchema>;

export const BacklogItemArraySchema = z.array(BacklogItemSchema);

/**
 * Schema do JSON bruto de um lote de requisitos (comando `backlog` com BACKLOG_BATCH_SIZE
 * > 1, ver buildBacklogBatchRequest): mesmos campos de BacklogItemDraftSchema, mais
 * `requirementId` para casar cada item com seu requisito. Exige exatamente um item por id
 * de `ids`, em qualquer ordem — nem faltando, nem duplicado, nem um id fora do lote.
 */
export function BacklogItemBatchDraftSchema(ids: readonly string[]) {
  const idSet = new Set(ids);
  return z
    .array(
      z
        .object({
          requirementId: z
            .string()
            .describe('O id do requisito (entre colchetes no prompt) a que este item corresponde.'),
          ...aiGeneratedShape,
          technicalSpecificity: TechnicalSpecificitySchema,
        })
        .refine(hasReproStepsWhenBug, REPRO_STEPS_ISSUE)
        .superRefine(backlogQualityRules),
    )
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (!idSet.has(item.requirementId)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'requirementId'],
            message: `requirementId "${item.requirementId}" não está entre os ids pedidos (${ids.join(', ')}).`,
          });
          return;
        }
        if (seen.has(item.requirementId)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'requirementId'],
            message: `requirementId "${item.requirementId}" duplicado: cada requisito deve gerar exatamente um item.`,
          });
          return;
        }
        seen.add(item.requirementId);
      });
      const missing = ids.filter((id) => !seen.has(id));
      if (missing.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: [],
          message: `faltam itens para os requisitos: ${missing.join(', ')}.`,
        });
      }
    });
}
export type BacklogItemBatchDraft = BacklogItemDraft & { requirementId: string };
