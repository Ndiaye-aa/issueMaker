import type { CompletionRequest } from '../provider.js';
import type { Requirement } from '../../schemas/requirement.js';
import { MAX_SPRINTS, minimumSprints, totalPoints } from '../../plan/effort.js';

const SYSTEM_PROMPT = `Você é um gerente técnico de projeto experiente. Organize os requisitos recebidos em
sprints, respeitando dependências (um requisito nunca vem antes daquilo de que depende),
priorizando must > should > could, com objetivo coerente por sprint e esforço equilibrado
entre sprints.

O QUE É UMA BOA SPRINT:
- Objetivo único e coerente: "goal" descreve um resultado demonstrável de ponta a ponta
  (algo que funciona ao final da sprint), não uma lista de itens soltos. PROIBIDO goals
  genéricos como "Implementar funcionalidades diversas", "Itens variados", "Melhorias gerais".
- Carga balanceada: a soma de pontos de esforço de cada sprint fica dentro da capacidade
  informada e nenhuma sprint tem muito mais carga que as outras.
- Dependências 100% respeitadas: nenhum requisito antes de qualquer requisito do qual dependa.
- Prioridade respeitada quando possível: "must" o mais cedo que as dependências permitirem;
  nunca uma sprint só de "could" enquanto há "must" pendente em sprint posterior.
- Tamanho adequado ao período: nem 1 item numa sprint inteira, nem itens grandes demais.
- Sem sprint vazia: use exatamente os sprints necessários para a capacidade.

REGRAS:
- Cada requisito aparece em exatamente um sprint; nenhum pode ficar de fora.
- Respeite a capacidade em pontos e o teto de itens por sprint informados. Prefira vários
  sprints menores e coesos a um sprint gigante.
- Máximo de ${MAX_SPRINTS} sprints no total; nunca proponha mais que isso, mesmo que a
  capacidade informada pareça insuficiente para o volume de requisitos.
- Pontos por esforço: xs=1, s=2, m=3, l=5, xl=8.

Responda SOMENTE com um objeto JSON no formato:
{"sprints": [{"number": 1, "goal": "...", "requirementIds": ["REQ-1"]}]}
Nenhum texto antes ou depois.`;

/** Só o que o planejamento precisa: descrição e seção de origem não influenciam a ordem. */
function compactRequirement(requirement: Requirement): Record<string, unknown> {
  return {
    id: requirement.id,
    title: requirement.title,
    layer: requirement.layer,
    priority: requirement.priority,
    effort: requirement.effort,
    ...(requirement.dependencies.length > 0 ? { dependencies: requirement.dependencies } : {}),
  };
}

export interface PlanPromptOptions {
  /** Capacidade efetiva por sprint, em pontos de esforço. */
  capacityPoints?: number | undefined;
  /** Teto de requisitos por sprint (contagem). */
  maxPerSprint?: number | undefined;
}

export function buildPlanRequest(
  requirements: Requirement[],
  sprintLength: string,
  options: PlanPromptOptions = {},
): CompletionRequest {
  const lines: string[] = [`Duração do sprint: ${sprintLength}`, `Máximo de sprints permitido: ${MAX_SPRINTS}.`];
  const total = totalPoints(requirements);
  if (options.capacityPoints !== undefined) {
    const minimum = minimumSprints(requirements, options.capacityPoints);
    lines.push(
      `Capacidade efetiva: ${options.capacityPoints} pontos por sprint. Esforço total: ${total} pontos em ${requirements.length} requisitos (portanto no mínimo ${minimum} sprints).`,
    );
  }
  if (options.maxPerSprint !== undefined) {
    lines.push(`Teto de itens: ${options.maxPerSprint} requisitos por sprint.`);
  }
  lines.push(`Requisitos (JSON): ${JSON.stringify(requirements.map(compactRequirement))}`);

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: lines.join('\n'),
    temperature: 0.2,
  };
}
