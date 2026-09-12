import type { CompletionRequest } from '../provider.js';
import type { Chunk } from '../../ingest/chunker.js';

const SYSTEM_PROMPT = `Você é um analista de requisitos de software sênior. Sua tarefa é ler trechos de um
Documento de Design de Software (SDD) e extrair requisitos de forma estruturada.

Cada requisito deve ser um objeto JSON com os campos:
- "id": identificador curto (ex: "REQ-1").
- "title": título curto do requisito (poucas palavras).
- "description": descrição completa do requisito.
- "layer": "frontend", "backend" ou "shared", conforme o contexto.
- "priority": "must", "should" ou "could" (MoSCoW), conforme a criticidade do requisito.
- "dependencies": array com os ids de outros requisitos dos quais este depende tecnicamente (ou []).
- "sourceSection": título da seção de onde a informação veio.

REGRAS:
- Responda SOMENTE com um array JSON válido. Nenhum texto antes ou depois.
- Cada requisito deve ser atômico (uma responsabilidade só).
- Se a seção não tiver requisitos extraíveis, retorne [].`;

export function buildExtractRequest(chunk: Chunk, existingIds: string[]): CompletionRequest {
  const userPrompt = `Seção do SDD: "${chunk.sectionTitle}"
Conteúdo: """${chunk.content}"""
IDs já usados até agora: ${JSON.stringify(existingIds)}`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.1,
  };
}
