import type { CompletionRequest } from '../provider.js';
import type { Requirement, Layer } from '../../schemas/requirement.js';
import type { SprintPlan } from '../../schemas/sprint-plan.js';

const SYSTEM_PROMPT_TEMPLATE = (layer: string) => `Você é um Product Owner técnico. Transforme requisitos de ${layer} em itens de
backlog prontos para virar issues no GitHub, seguindo boas práticas:
- Título específico e descritivo, nunca genérico
- Escopo único por item
- "expectedBehavior" obrigatório
- "reproSteps" obrigatório apenas quando type === "bug"
- "environment" apenas se especificado no SDD original
- Sem referências a prints/logs/GIFs
- "requirementIds" deve listar os ids (ex.: "REQ-001") de todos os requisitos de entrada que
  originaram esse item, para rastreabilidade até o SDD original

Responda SOMENTE com um array JSON de itens de backlog, no formato:
[{"id": "BL-001", "epic": "...", "type": "feature|bug|tech-debt", "title": "...",
"description": "...", "expectedBehavior": "...", "reproSteps": ["..."],
"environment": "...", "acceptanceCriteria": ["..."], "labels": ["..."],
"sprint": 1, "layer": "${layer}", "requirementIds": ["REQ-001"]}]
Nenhum texto antes ou depois.`;

export function buildBacklogRequest(
  layer: Exclude<Layer, 'shared'>,
  requirements: Requirement[],
  sprintPlan: SprintPlan,
): CompletionRequest {
  const filtered = requirements.filter((r) => r.layer === layer);
  const userPrompt = `Requisitos de ${layer} (JSON): ${JSON.stringify(filtered)}
Plano de sprints (JSON): ${JSON.stringify(sprintPlan)}`;

  return {
    systemPrompt: SYSTEM_PROMPT_TEMPLATE(layer),
    userPrompt,
    temperature: 0.3,
  };
}
