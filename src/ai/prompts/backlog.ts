import type { CompletionRequest } from '../provider.js';
import type { Requirement, Layer } from '../../schemas/requirement.js';
import type { Sprint } from '../../schemas/sprint-plan.js';

const SYSTEM_PROMPT_TEMPLATE = (layer: string) => `Você é um Product Owner técnico. Transforme requisitos de ${layer} em itens de
backlog prontos para virar issues no GitHub, seguindo boas práticas:
- Título específico e descritivo, nunca genérico
- "description" objetiva: o que está acontecendo (bug) ou o que precisa existir (feature),
  sem opinião ou suposição
- Escopo único por item: um problema ou uma funcionalidade por issue, nunca misture assuntos
- "expectedBehavior" obrigatório: o que deveria acontecer em vez do estado atual
- "acceptanceCriteria" obrigatório: lista com pelo menos um critério testável que define
  quando a issue está pronta para ser fechada
- "reproSteps" obrigatório apenas quando type === "bug": passo a passo exato, sem lacunas
- "environment" apenas se especificado no SDD original
- Sem referências a prints/logs/GIFs
- "requirementIds" deve listar os ids (ex.: "REQ-001") de todos os requisitos de entrada que
  originaram esse item, para rastreabilidade até o SDD original
- Todos os itens pertencem ao sprint informado: "sprint" deve ser exatamente esse número
- "id" sequencial dentro desta resposta ("BL-1", "BL-2", ...); a numeração final é feita depois

Responda SOMENTE com um array JSON de itens de backlog, no formato:
[{"id": "BL-1", "epic": "...", "type": "feature|bug|tech-debt", "title": "...",
"description": "...", "expectedBehavior": "...", "reproSteps": ["..."],
"environment": "...", "acceptanceCriteria": ["..."], "labels": ["..."],
"sprint": <número do sprint informado>, "layer": "${layer}", "requirementIds": ["REQ-001"]}]
Nenhum texto antes ou depois.`;

export function buildBacklogRequest(
  layer: Exclude<Layer, 'shared'>,
  requirements: Requirement[],
  sprint: Sprint,
): CompletionRequest {
  const userPrompt = `Sprint ${sprint.number} — objetivo: ${sprint.goal}
Requisitos de ${layer} deste sprint (JSON): ${JSON.stringify(requirements)}

Gere os itens de backlog destes requisitos, todos com "sprint": ${sprint.number}.`;

  return {
    systemPrompt: SYSTEM_PROMPT_TEMPLATE(layer),
    userPrompt,
    temperature: 0.3,
  };
}
