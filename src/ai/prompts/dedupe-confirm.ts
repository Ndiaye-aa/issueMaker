import { z } from 'zod';
import type { CompletionRequest } from '../provider.js';
import type { Requirement } from '../../schemas/requirement.js';

export const DedupeConfirmSchema = z.object({ same: z.boolean() });

const SYSTEM_PROMPT = `Você é um analista de requisitos de software sênior. Responda SOMENTE com um
objeto JSON no formato {"same": true} ou {"same": false}. Nenhum texto antes ou depois.`;

export function buildDedupeConfirmRequest(a: Requirement, b: Requirement): CompletionRequest {
  const userPrompt = `Requisito A: ${JSON.stringify({ title: a.title, description: a.description })}
Requisito B: ${JSON.stringify({ title: b.title, description: b.description })}

Esses dois requisitos descrevem a mesma coisa?`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0,
    // Decisão binária e mecânica: um modelo leve resolve pelo mesmo preço de uma fração
    // do modelo principal (ver ClaudeCodeProvider.lightModel).
    tier: 'light',
  };
}
