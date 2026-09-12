import type { CompletionRequest } from '../provider.js';
import type { Chunk } from '../../ingest/chunker.js';

const SYSTEM_PROMPT = `Você é um analista de requisitos de software sênior. Sua tarefa é ler trechos de um
Documento de Design de Software (SDD) e extrair requisitos de forma estruturada.

REGRAS:
- Responda SOMENTE com um array JSON válido. Nenhum texto antes ou depois.
- Cada requisito deve ser atômico (uma responsabilidade só).
- Classifique "layer" como "frontend", "backend" ou "shared" com base no contexto.
- Se um requisito depende de outro para fazer sentido tecnicamente, liste o id dele em "dependencies".
- "sourceSection" deve citar o título da seção de onde a informação veio.
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
