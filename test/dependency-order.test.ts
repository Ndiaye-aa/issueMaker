import type { BacklogItem } from '../src/schemas/backlog-item.js';
import { findDependencyCycle, sortTopologically, topologicalLayers } from '../src/publish/dependency-order.js';

function item(id: string, requirementId: string, dependsOn: string[] = [], sprint = 1): BacklogItem {
  return {
    id,
    epic: 'E',
    type: 'feature',
    priority: 'must',
    title: `Item ${id} com título suficientemente longo`,
    description: 'Descrição objetiva e detalhada',
    expectedBehavior: 'Comportamento esperado claro',
    acceptanceCriteria: ['Critério'],
    labels: [],
    sprint,
    layer: 'backend',
    requirementIds: [requirementId],
    dependsOn,
  };
}

const ids = (items: BacklogItem[]) => items.map((i) => i.id);

describe('sortTopologically', () => {
  it('mantém a ordem original quando não há dependências', () => {
    const items = [item('A', 'REQ-1'), item('B', 'REQ-2'), item('C', 'REQ-3')];
    expect(ids(sortTopologically(items))).toEqual(['A', 'B', 'C']);
  });

  it('coloca a dependência antes do dependente mesmo se listada depois, mexendo o mínimo', () => {
    const items = [item('A', 'REQ-1', ['REQ-3']), item('B', 'REQ-2'), item('C', 'REQ-3')];
    expect(ids(sortTopologically(items))).toEqual(['B', 'C', 'A']);
  });

  it('resolve cadeias de vários níveis', () => {
    const items = [item('C', 'REQ-3', ['REQ-2']), item('B', 'REQ-2', ['REQ-1']), item('A', 'REQ-1')];
    expect(ids(sortTopologically(items))).toEqual(['A', 'B', 'C']);
  });

  it('dependências fora do conjunto não bloqueiam', () => {
    const items = [item('A', 'REQ-1', ['REQ-77']), item('B', 'REQ-2', ['REQ-1'])];
    expect(ids(sortTopologically(items))).toEqual(['A', 'B']);
  });

  it('lança erro citando o ciclo', () => {
    const items = [item('A', 'REQ-1', ['REQ-2']), item('B', 'REQ-2', ['REQ-3']), item('C', 'REQ-3', ['REQ-1'])];
    expect(() => sortTopologically(items)).toThrow('ciclo de dependências entre requisitos: REQ-1 → REQ-2 → REQ-3 → REQ-1');
  });
});

describe('topologicalLayers', () => {
  const layerIds = (layers: BacklogItem[][]) => layers.map(ids);

  it('sem dependências, agrupa tudo numa única camada, ordem preservada', () => {
    const items = [item('A', 'REQ-1'), item('B', 'REQ-2'), item('C', 'REQ-3')];
    expect(layerIds(topologicalLayers(items))).toEqual([['A', 'B', 'C']]);
  });

  it('cadeia linear vira uma camada por item', () => {
    const items = [item('C', 'REQ-3', ['REQ-2']), item('B', 'REQ-2', ['REQ-1']), item('A', 'REQ-1')];
    expect(layerIds(topologicalLayers(items))).toEqual([['A'], ['B'], ['C']]);
  });

  it('itens independentes que dependem do mesmo item caem na mesma camada seguinte', () => {
    const items = [item('A', 'REQ-1'), item('B', 'REQ-2', ['REQ-1']), item('C', 'REQ-3', ['REQ-1'])];
    expect(layerIds(topologicalLayers(items))).toEqual([['A'], ['B', 'C']]);
  });

  it('dependências fora do conjunto não bloqueiam', () => {
    const items = [item('A', 'REQ-1', ['REQ-77']), item('B', 'REQ-2', ['REQ-1'])];
    expect(layerIds(topologicalLayers(items))).toEqual([['A'], ['B']]);
  });

  it('lança erro citando o ciclo', () => {
    const items = [item('A', 'REQ-1', ['REQ-2']), item('B', 'REQ-2', ['REQ-3']), item('C', 'REQ-3', ['REQ-1'])];
    expect(() => topologicalLayers(items)).toThrow('ciclo de dependências entre requisitos: REQ-1 → REQ-2 → REQ-3 → REQ-1');
  });
});

describe('findDependencyCycle', () => {
  it('devolve undefined sem ciclo e ignora auto-referência', () => {
    expect(findDependencyCycle([item('A', 'REQ-1', ['REQ-1']), item('B', 'REQ-2', ['REQ-1'])])).toBeUndefined();
  });

  it('encontra um ciclo parcial no meio de um grafo maior', () => {
    const items = [item('A', 'REQ-1'), item('B', 'REQ-2', ['REQ-3']), item('C', 'REQ-3', ['REQ-2'])];
    expect(findDependencyCycle(items)).toEqual(['REQ-2', 'REQ-3', 'REQ-2']);
  });
});
