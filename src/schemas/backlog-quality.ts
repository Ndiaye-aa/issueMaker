import type { z } from 'zod';

/**
 * Regras de qualidade do prompt de backlog (src/ai/prompts/backlog.ts) na forma de
 * validação determinística. Rodam só sobre o rascunho gerado pela IA: cada violação vira
 * uma issue zod com mensagem acionável, que o ResilientAIClient devolve ao modelo no retry.
 * Nunca aplicar ao BacklogItemSchema do round-trip, para não rejeitar backlogs já revisados.
 */

export const TITLE_MAX_LENGTH = 70;
export const TITLE_MIN_WORDS = 4;
export const NO_NEGATIVE_CASE_PREFIX = 'Nenhum caso negativo aplicável';

const VAGUE_TERMS_REGEX =
  /\b(corretamente|com sucesso|de forma adequada|adequadamente|apropriadamente|funcionar[áa]?\s+corretamente|conforme (o )?esperado)\b/i;
const INFINITIVE_VERB_REGEX = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]*(ar|er|ir|or)\b/;
const TYPE_PREFIX_REGEX = /^(bug|feature|tech-?debt|d[ée]bito t[ée]cnico|erro|problema)\s*[:\-–]/i;

export interface BacklogDraftLike {
  title: string;
  description: string;
  expectedBehavior: string;
  acceptanceCriteria: string[];
  technicalSpecificity?: { needsClarification: boolean; clarificationNote: string | null } | undefined;
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenJaccard(a: string, b: string): number {
  const setA = new Set(normalizeText(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export function findVagueTerm(text: string): string | undefined {
  return VAGUE_TERMS_REGEX.exec(text)?.[0];
}

export function backlogQualityRules(draft: BacklogDraftLike, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  // REGRA 5 — título
  const title = draft.title.trim();
  if (title.length > TITLE_MAX_LENGTH) {
    issue(['title'], `title tem ${title.length} caracteres; máximo ${TITLE_MAX_LENGTH}. Encurte mantendo verbo + objeto + contexto.`);
  }
  if (TYPE_PREFIX_REGEX.test(title)) {
    issue(['title'], 'title não pode começar com o tipo ("Bug:", "Feature:"...): a label já classifica. Remova o prefixo.');
  } else if (!INFINITIVE_VERB_REGEX.test(title)) {
    issue(['title'], 'title deve começar com verbo no infinitivo (Implementar, Corrigir, Validar, Adicionar...) seguido do objeto específico.');
  }
  const words = normalizeText(title).split(' ').filter(Boolean);
  if (words.length < TITLE_MIN_WORDS) {
    issue(['title'], `title genérico ("${title}"): precisa de pelo menos ${TITLE_MIN_WORDS} palavras dizendo o objeto e o contexto (ex.: "Validar formato de e-mail no cadastro de usuário").`);
  }

  // REGRA 4 — termos vagos
  const vagueInDescription = findVagueTerm(draft.description);
  if (vagueInDescription) {
    issue(['description'], `description usa "${vagueInDescription}" sem dizer o que isso significa tecnicamente. Substitua por comportamento concreto (código de status, campo, limite, mensagem).`);
  }
  const vagueInExpected = findVagueTerm(draft.expectedBehavior);
  if (vagueInExpected) {
    issue(['expectedBehavior'], `expectedBehavior usa "${vagueInExpected}" sem qualificar. Descreva o resultado observável com valores concretos.`);
  }
  draft.acceptanceCriteria.forEach((criterion, index) => {
    const vague = findVagueTerm(criterion);
    if (vague) {
      issue(['acceptanceCriteria', index], `critério ${index + 1} usa "${vague}": não é verificável. Reescreva como "Quando X, então Y" com valores concretos.`);
    }
  });

  // REGRA 1 — descrição ≠ comportamento esperado
  if (
    normalizeText(draft.description) === normalizeText(draft.expectedBehavior) ||
    tokenJaccard(draft.description, draft.expectedBehavior) > 0.8
  ) {
    issue(['expectedBehavior'], 'description e expectedBehavior dizem a mesma coisa. description = mecanismo (o que implementar / o que está quebrado); expectedBehavior = resultado observável.');
  }

  // REGRAS 2 e 3 — critérios testáveis, distintos, com caso negativo
  const hasNoNegativeJustification = draft.acceptanceCriteria.some((criterion) =>
    normalizeText(criterion).startsWith(normalizeText(NO_NEGATIVE_CASE_PREFIX)),
  );
  if (draft.acceptanceCriteria.length < 2 && !hasNoNegativeJustification) {
    issue(['acceptanceCriteria'], `acceptanceCriteria precisa de pelo menos 1 caminho de sucesso + 1 caso negativo (entrada inválida, estado inválido ou limite). Se não houver caso negativo plausível, inclua um critério começando com "${NO_NEGATIVE_CASE_PREFIX} — justificativa: ...".`);
  }
  // Só duplicata exata: critérios "Quando X, então Y" espelham o caso positivo e o negativo
  // trocando poucas palavras, e uma medida de sobreposição de tokens reprovaria pares legítimos.
  const seen = new Map<string, number>();
  draft.acceptanceCriteria.forEach((criterion, index) => {
    const key = normalizeText(criterion);
    const first = seen.get(key);
    if (first !== undefined) {
      issue(['acceptanceCriteria', index], `critério ${index + 1} repete o critério ${first + 1}. Cada critério deve testar uma dimensão diferente (entrada, resultado ou regra de negócio).`);
    } else {
      seen.set(key, index);
    }
  });

  // technicalSpecificity coerente
  const spec = draft.technicalSpecificity;
  if (spec?.needsClarification && !(spec.clarificationNote ?? '').trim()) {
    issue(['technicalSpecificity', 'clarificationNote'], 'needsClarification é true: clarificationNote deve dizer exatamente qual decisão técnica falta ser tomada.');
  }
}
