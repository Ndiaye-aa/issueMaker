import type { CompletionRequest } from '../provider.js';
import type { Requirement, Layer } from '../../schemas/requirement.js';
import type { Sprint } from '../../schemas/sprint-plan.js';

// Compacto de propósito: cada char aqui é reenviado em toda chamada de backlog. O formato
// de saída não precisa mais ser descrito em texto — o JSON Schema da saída estruturada
// (com .describe() em cada campo, ver src/schemas/backlog-item.ts) já o impõe.
export const BACKLOG_SYSTEM_PROMPT = `Você é um engenheiro de software sênior especializado em escrever issues técnicas de altíssima qualidade. Transforme o requisito abaixo em uma issue completa, seguindo as regras. Responda somente com o JSON do schema — sem texto antes ou depois.

REGRA 1 — DESCRIÇÃO: explique O QUE implementar ou O QUE está quebrado (o mecanismo), nunca o efeito observável — isso é o campo "Comportamento Esperado", que não pode repetir a mesma ideia com outras palavras. Cite componentes técnicos (endpoint, tabela, serviço, tela, evento) quando o requisito permitir. Proibido "deve funcionar corretamente" ou qualquer frase vaga equivalente.

REGRA 2 — CRITÉRIOS DE ACEITE: 3 a 6 critérios testáveis objetivamente ("Quando X, então Y"), cada um cobrindo uma dimensão diferente (entrada, resultado ou regra de negócio distintos — nunca a mesma afirmação com sinônimos). Pelo menos 1 critério de caminho de sucesso.

REGRA 3 — CASOS NEGATIVOS: cubra ao menos um caminho de erro plausível — entrada inválida/ausente, estado inválido (recurso já existe/não existe, permissão insuficiente, conflito) ou limite (mínimo, máximo, zero). Cada caso negativo vira um critério de aceite (Regra 2). Se genuinamente não houver caminho de erro, declare isso explicitamente em vez de omitir a seção.

REGRA 4 — ESPECIFICIDADE TÉCNICA: proibido "corretamente"/"com sucesso"/"de forma adequada" sem qualificar tecnicamente. Sempre que o requisito permitir inferir, inclua códigos HTTP, nomes de campos/endpoints/mensagens de erro, limites numéricos e formato de dados. Se faltar informação para ser específico, marque needsClarification: true e explique a decisão técnica pendente — nunca invente um número.

REGRA 5 — TÍTULO: [verbo de ação no infinitivo] + [objeto específico] + [contexto se necessário]. Máximo 70 caracteres. Proibido repetir o tipo ("Bug:", "Feature:") — a label já classifica. Para bugs, descreva o sintoma observável, não a causa suposta. Teste anti-genérico: se o título valesse para qualquer funcionalidade do sistema trocando uma palavra, está vago.
  ✅ "Validar formato de e-mail no cadastro de usuário"
  ✅ "Corrigir timeout no upload de arquivos acima de 10MB"
  ❌ "Problema no cadastro" (genérico, não localiza o que é)

Seja conciso: cada campo tem um limite de tamanho no schema. Não repita o contexto do sprint no texto da issue.`;

export function buildBacklogRequest(
  layer: Exclude<Layer, 'shared'>,
  requirement: Requirement,
  sprint: Sprint,
): CompletionRequest {
  const sharedNote =
    requirement.layer === 'shared'
      ? ` Este requisito é "shared" (transversal: infra, dados, segurança) e deve virar um item de ${layer}.`
      : '';
  const dependencies =
    requirement.dependencies.length > 0 ? requirement.dependencies.join(', ') : 'nenhuma';
  const context = [
    `Sprint ${sprint.number} — objetivo: ${sprint.goal}.`,
    `Camada: ${layer}.${sharedNote}`,
    `Prioridade (MoSCoW): ${requirement.priority}.`,
    `Esforço estimado: ${requirement.effort}.`,
    `Seção do SDD de origem: ${requirement.sourceSection}.`,
    `Dependências: ${dependencies}.`,
  ].join(' ');

  const userPrompt = `Requisito original: """${requirement.title}. ${requirement.description}"""
Contexto adicional (se houver): """${context}"""`;

  return {
    systemPrompt: BACKLOG_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
  };
}

function requirementContext(layer: Exclude<Layer, 'shared'>, requirement: Requirement): string {
  const sharedNote =
    requirement.layer === 'shared'
      ? ` Este requisito é "shared" (transversal: infra, dados, segurança) e deve virar um item de ${layer}.`
      : '';
  const dependencies =
    requirement.dependencies.length > 0 ? requirement.dependencies.join(', ') : 'nenhuma';
  return [
    `Camada: ${layer}.${sharedNote}`,
    `Prioridade (MoSCoW): ${requirement.priority}.`,
    `Esforço estimado: ${requirement.effort}.`,
    `Seção do SDD de origem: ${requirement.sourceSection}.`,
    `Dependências: ${dependencies}.`,
  ].join(' ');
}

/**
 * Um lote de requisitos da mesma sprint/camada numa só chamada: o system prompt (a maior
 * parte da entrada) deixa de ser reenviado uma vez por requisito. `requirementId` na
 * resposta identifica cada item — ver BacklogItemBatchDraftSchema, que exige exatamente um
 * item por id do lote.
 */
export function buildBacklogBatchRequest(
  layer: Exclude<Layer, 'shared'>,
  requirements: Requirement[],
  sprint: Sprint,
): CompletionRequest {
  const items = requirements
    .map(
      (requirement) => `[${requirement.id}] Requisito: """${requirement.title}. ${requirement.description}"""
Contexto: """${requirementContext(layer, requirement)}"""`,
    )
    .join('\n\n');

  const userPrompt = `Sprint ${sprint.number} — objetivo: ${sprint.goal}.

Gere exatamente um item de backlog para cada um dos ${requirements.length} requisitos abaixo — nunca combine dois requisitos em um item, nem invente itens extras. Preencha "requirementId" com o id exato entre colchetes de cada requisito.

${items}`;

  return {
    systemPrompt: BACKLOG_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
  };
}
