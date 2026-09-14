export interface Chunk {
  sectionTitle: string;
  content: string;
}

const HEADING_REGEX = /^#{1,6}\s+(.+)$/;
// Aproximação simples: ~4 caracteres por token (regra prática para modelos GPT/Llama-like)
const CHARS_PER_TOKEN = 4;

export function splitIntoSections(text: string): Chunk[] {
  const lines = text.split('\n');
  const sections: Chunk[] = [];
  let currentTitle = 'Introdução';
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(HEADING_REGEX);
    if (match) {
      if (currentLines.length > 0) {
        sections.push({ sectionTitle: currentTitle, content: currentLines.join('\n').trim() });
      }
      currentTitle = match[1]?.trim() ?? currentTitle;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    sections.push({ sectionTitle: currentTitle, content: currentLines.join('\n').trim() });
  }

  return sections.filter((section) => section.content.length > 0);
}

/**
 * Divide uma seção grande em partes de até `maxTokens`, preferindo cortar em quebra de
 * parágrafo, depois em quebra de linha, e só em último caso no meio de uma linha. Um
 * requisito partido ao meio entre dois chunks tende a ser extraído duas vezes (ou nenhuma).
 */
export function chunkByTokenLimit(chunk: Chunk, maxTokens: number): Chunk[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (chunk.content.length <= maxChars) {
    return [chunk];
  }

  const parts: Chunk[] = [];
  let remaining = chunk.content;
  let partIndex = 1;
  while (remaining.length > 0) {
    const cut = remaining.length <= maxChars ? remaining.length : findCutPoint(remaining, maxChars);
    parts.push({
      sectionTitle: `${chunk.sectionTitle} (parte ${partIndex})`,
      content: remaining.slice(0, cut),
    });
    remaining = remaining.slice(cut);
    partIndex += 1;
  }
  return parts;
}

function findCutPoint(text: string, maxChars: number): number {
  // Só aceitamos um corte "bonito" se ele não deixar a parte pequena demais.
  const minChars = Math.floor(maxChars / 2);
  for (const separator of ['\n\n', '\n', '. ', ' ']) {
    const index = text.lastIndexOf(separator, maxChars);
    if (index >= minChars) {
      return index + separator.length;
    }
  }
  return maxChars;
}

export function chunkDocument(text: string, maxTokensPerChunk = 1000): Chunk[] {
  const sections = splitIntoSections(text);
  return sections.flatMap((section) => chunkByTokenLimit(section, maxTokensPerChunk));
}
