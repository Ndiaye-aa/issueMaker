import { findSimilarPairs, titleSimilarity } from '../src/ingest/dedupe.js';

describe('titleSimilarity', () => {
  it('retorna 1 para títulos idênticos', () => {
    expect(titleSimilarity('Login de usuário', 'Login de usuário')).toBe(1);
  });

  it('retorna 0 para títulos completamente diferentes', () => {
    expect(titleSimilarity('Login de usuário', 'Exportar relatório em PDF')).toBe(0);
  });

  it('retorna um valor intermediário para títulos parecidos', () => {
    const similarity = titleSimilarity('Login de usuário via e-mail', 'Login de usuário via SSO');
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });
});

describe('findSimilarPairs', () => {
  it('encontra pares acima do threshold', () => {
    const items = [
      { id: '1', title: 'Login de usuário' },
      { id: '2', title: 'Login de usuário' },
      { id: '3', title: 'Exportar relatório em PDF' },
    ];
    const pairs = findSimilarPairs(items, (item) => item.title, 0.6);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a.id).toBe('1');
    expect(pairs[0]?.b.id).toBe('2');
  });
});
