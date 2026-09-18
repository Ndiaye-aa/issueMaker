import { z } from 'zod';
import type { CompletionRequest } from '../provider.js';
import type { Requirement } from '../../schemas/requirement.js';
import type { Sprint } from '../../schemas/sprint-plan.js';

export const GENERIC_GOAL_REGEX =
  /funcionalidades diversas|itens variados|diversos ajustes|melhorias gerais|requisitos diversos|tarefas variadas/i;
export const GOAL_MIN_LENGTH = 25;

export const SprintGoalsSchema = z.object({
  goals: z.array(
    z.object({
      number: z.number().int().positive(),
      goal: z
        .string()
        .min(GOAL_MIN_LENGTH, `goal deve descrever um resultado demonstrável (mínimo ${GOAL_MIN_LENGTH} caracteres)`)
        .refine((goal) => !GENERIC_GOAL_REGEX.test(goal), 'goal genérico: descreva o que funciona de ponta a ponta ao final da sprint'),
    }),
  ),
});

const SYSTEM_PROMPT = `Você é um gerente técnico de projeto. Para cada sprint recebida, escreva o "goal": 1 ou 2
frases descrevendo o resultado demonstrável de ponta a ponta que a sprint entrega, com base
nos requisitos alocados nela. O goal dá contexto de propósito; as issues já são a lista.
PROIBIDO goals genéricos ("Implementar funcionalidades diversas", "Itens variados").

Responda SOMENTE com um objeto JSON no formato:
{"goals": [{"number": 1, "goal": "..."}]}
Nenhum texto antes ou depois.`;

/**
 * Reescreve só os goals quando a distribuição determinística mudou a composição das sprints
 * e o goal proposto pela IA deixou de refletir o que está nelas.
 */
export function buildSprintGoalsRequest(sprints: Sprint[], requirements: Requirement[]): CompletionRequest {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const payload = sprints.map((sprint) => ({
    number: sprint.number,
    currentGoal: sprint.goal,
    requirements: sprint.requirementIds.map((id) => {
      const requirement = byId.get(id);
      return requirement ? { id, title: requirement.title, layer: requirement.layer } : { id };
    }),
  }));
  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Sprints (JSON): ${JSON.stringify(payload)}`,
    temperature: 0.2,
  };
}
