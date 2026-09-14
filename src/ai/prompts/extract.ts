import type { CompletionRequest } from '../provider.js';
import type { Chunk } from '../../ingest/chunker.js';

const SYSTEM_PROMPT = `Você é um analista de requisitos de software sênior. Sua tarefa é ler trechos de um
Documento de Design de Software (SDD) e extrair TODOS os requisitos funcionais e não funcionais
que eles descrevem — inclusive os implícitos em descrições de funcionalidades, telas, regras de
negócio, entidades, integrações e metas de performance/segurança. Um trecho descritivo
normalmente contém vários requisitos.

Cada requisito deve ser um objeto JSON com os campos:
- "id": identificador curto e sequencial (ex: "REQ-1"), sem repetir IDs já usados.
- "title": título curto do requisito (poucas palavras).
- "description": frase completa ("O sistema deve ...").
- "layer": "frontend", "backend" ou "shared", conforme o contexto.
- "priority": "must", "should" ou "could" (MoSCoW), conforme a criticidade do requisito.
- "dependencies": array com os ids de outros requisitos dos quais este depende tecnicamente (ou []).
- "sourceSection": título da seção de onde a informação veio.

Exemplo — o trecho "Usuários fazem login com e-mail e senha e podem recuperar a senha por e-mail" gera:
[{"id":"REQ-1","title":"Login com e-mail e senha","description":"O sistema deve autenticar o usuário com e-mail e senha.","layer":"backend","priority":"must","dependencies":[],"sourceSection":"Autenticação"},{"id":"REQ-2","title":"Recuperação de senha por e-mail","description":"O sistema deve permitir recuperar a senha por e-mail.","layer":"backend","priority":"should","dependencies":["REQ-1"],"sourceSection":"Autenticação"}]

REGRAS:
- Responda SOMENTE com um array JSON válido. Nenhum texto antes ou depois.
- Cada requisito deve ser atômico (uma responsabilidade só).
- Retorne um array vazio SOMENTE se o trecho for exclusivamente capa, sumário, histórico de
  versões ou glossário do documento.`;

export function buildExtractRequest(chunk: Chunk, existingIds: string[]): CompletionRequest {
  // A lista de IDs vem antes do conteúdo (e é omitida quando vazia) porque um "[]" no fim do
  // prompt induz modelos pequenos a responderem um array vazio.
  const idsLine = existingIds.length > 0 ? `IDs já usados (não repita): ${existingIds.join(', ')}\n` : '';
  const userPrompt = `${idsLine}Seção do SDD: "${chunk.sectionTitle}"
Conteúdo:
"""
${chunk.content}
"""

Extraia agora todos os requisitos deste trecho como array JSON.`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.1,
  };
}
