import { resolvePriority } from '../src/backlog/priority.js';
import type { Requirement } from '../src/schemas/requirement.js';

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-001',
    title: 'Requisito',
    description: 'Descrição do requisito',
    layer: 'backend',
    priority: 'should',
    dependencies: [],
    sourceSection: 'Seção 1',
    ...overrides,
  };
}

describe('resolvePriority', () => {
  it('retorna a prioridade do único requisito referenciado', () => {
    const requirements = [makeRequirement({ id: 'REQ-001', priority: 'could' })];
    expect(resolvePriority(['REQ-001'], requirements)).toBe('could');
  });

  it('retorna a prioridade mais alta entre múltiplos requisitos referenciados', () => {
    const requirements = [
      makeRequirement({ id: 'REQ-001', priority: 'could' }),
      makeRequirement({ id: 'REQ-002', priority: 'must' }),
      makeRequirement({ id: 'REQ-003', priority: 'should' }),
    ];
    expect(resolvePriority(['REQ-001', 'REQ-002', 'REQ-003'], requirements)).toBe('must');
  });

  it('ignora requisitos não referenciados', () => {
    const requirements = [
      makeRequirement({ id: 'REQ-001', priority: 'must' }),
      makeRequirement({ id: 'REQ-002', priority: 'could' }),
    ];
    expect(resolvePriority(['REQ-002'], requirements)).toBe('could');
  });

  it('usa "should" como fallback quando requirementIds está vazio', () => {
    const requirements = [makeRequirement({ id: 'REQ-001', priority: 'must' })];
    expect(resolvePriority([], requirements)).toBe('should');
  });

  it('usa "should" como fallback quando nenhum id casa com um requisito existente', () => {
    const requirements = [makeRequirement({ id: 'REQ-001', priority: 'must' })];
    expect(resolvePriority(['REQ-999'], requirements)).toBe('should');
  });
});
