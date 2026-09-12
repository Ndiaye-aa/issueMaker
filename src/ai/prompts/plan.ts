import type { CompletionRequest } from '../provider.js';
import type { Requirement } from '../../schemas/requirement.js';

const SYSTEM_PROMPT = `Você é um gerente técnico de projeto experiente. Organize os requisitos recebidos em
sprints, respeitando dependências, priorizando must > should > could, com objetivo
coerente por sprint e esforço equilibrado entre sprints.

Responda SOMENTE com um objeto JSON no formato:
{"sprints": [{"number": 1, "goal": "...", "requirementIds": ["REQ-001"]}]}
Nenhum texto antes ou depois.`;

export function buildPlanRequest(requirements: Requirement[], sprintLength: string): CompletionRequest {
  const userPrompt = `Requisitos (JSON): ${JSON.stringify(requirements)}
Duração do sprint: ${sprintLength}`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
  };
}
