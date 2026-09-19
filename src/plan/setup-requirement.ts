import type { Requirement } from '../schemas/requirement.js';

/**
 * Heurística por palavra-chave (mesmo princípio de ENVIRONMENT_HINT_REGEX em
 * build-backlog.ts): reconhece tarefas de scaffolding/infra/deploy — que tipicamente não têm
 * dependência nenhuma e deveriam ser as primeiras do backlog — sem confundir com features de
 * negócio que também usam palavras como "configuração" (ex.: "desconto configurável por
 * diretoria" não é setup, é regra de negócio).
 */
const SETUP_TASK_REGEX =
  /\b(stack (de frontend|de backend|tecnol[oó]gica)|pipeline de ci\/?cd|\bci\/?cd\b|vari[aá]ve(l|is) de ambiente|build e deploy|deploy (do|da|no|na)|url da api|exposi[cç][aã]o de porta|modo (de )?produ[cç][aã]o|execu[cç][aã]o autom[aá]tica de migra[cç][oõ]es|migra[cç][oõ]es autom[aá]ticas)\b/i;

export function isSetupRequirement(requirement: Pick<Requirement, 'title' | 'description'>): boolean {
  return SETUP_TASK_REGEX.test(requirement.title) || SETUP_TASK_REGEX.test(requirement.description);
}
