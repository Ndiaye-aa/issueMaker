import { chunkByTokenLimit, chunkDocument, splitIntoSections } from '../src/ingest/chunker.js';

describe('splitIntoSections', () => {
  it('divide o texto em seções a partir dos headings', () => {
    const text = '# Título\nintro\n## Seção A\nconteúdo A\n## Seção B\nconteúdo B\n';
    const sections = splitIntoSections(text);

    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ sectionTitle: 'Título', content: 'intro' });
    expect(sections[1]).toMatchObject({ sectionTitle: 'Seção A', content: 'conteúdo A' });
    expect(sections[2]).toMatchObject({ sectionTitle: 'Seção B', content: 'conteúdo B' });
  });

  it('ignora seções vazias', () => {
    const text = '## Vazia\n## Com conteúdo\nalgo aqui\n';
    const sections = splitIntoSections(text);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.sectionTitle).toBe('Com conteúdo');
  });
});

describe('chunkByTokenLimit', () => {
  it('não divide quando o conteúdo cabe no limite', () => {
    const chunk = { sectionTitle: 'S', content: 'curto' };
    expect(chunkByTokenLimit(chunk, 100)).toEqual([chunk]);
  });

  it('divide o conteúdo em partes quando excede o limite de tokens', () => {
    const chunk = { sectionTitle: 'S', content: 'a'.repeat(100) };
    const parts = chunkByTokenLimit(chunk, 10); // maxChars = 40

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.content).join('')).toBe(chunk.content);
  });
});

describe('chunkDocument', () => {
  it('combina divisão por seção e por tamanho de token', () => {
    const text = `## Seção Grande\n${'palavra '.repeat(2000)}`;
    const chunks = chunkDocument(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('chunkByTokenLimit — pontos de corte', () => {
  it('prefere cortar em quebra de parágrafo a cortar no meio de uma linha', () => {
    const paragraph = 'palavra '.repeat(6).trim(); // 47 chars
    const content = [paragraph, paragraph, paragraph].join('\n\n'); // 145 chars
    const parts = chunkByTokenLimit({ sectionTitle: 'S', content }, 25); // maxChars = 100

    expect(parts).toHaveLength(2);
    expect(parts[0]?.content).toBe(`${paragraph}\n\n${paragraph}\n\n`);
    expect(parts[1]?.content).toBe(paragraph);
    expect(parts.map((p) => p.content).join('')).toBe(content);
  });

  it('cai para corte bruto quando não há separador razoável', () => {
    const parts = chunkByTokenLimit({ sectionTitle: 'S', content: 'x'.repeat(95) }, 10);
    expect(parts.map((p) => p.content.length)).toEqual([40, 40, 15]);
  });
});
