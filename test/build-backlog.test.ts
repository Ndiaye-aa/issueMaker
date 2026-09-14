import { jest } from '@jest/globals';
import type { ZodType } from 'zod';
import { buildBacklogForLayer } from '../src/backlog/build-backlog.js';
import type { Requirement } from '../src/schemas/requirement.js';
import type { SprintPlan } from '../src/schemas/sprint-plan.js';

function makeRequirement(id: string, layer: Requirement['layer'], priority: Requirement['priority'] = 'must'): Requirement {
  return {
    id,
    title: `Requisito ${id}`,
    description: `Descrição do requisito ${id}`,
    layer,
    priority,
    dependencies: [],
    sourceSection: 'Seção',
  };
}

function makeDraft(id: string, sprint: number, requirementIds: string[]) {
  return {
    id,
    epic: 'Epic',
    type: 'feature',
    title: `Item de backlog ${id} bem específico`,
    description: `Descrição objetiva e detalhada do item ${id}`,
    expectedBehavior: 'Comportamento esperado claro',
    acceptanceCriteria: ['Critério testável'],
    labels: [],
    sprint,
    layer: 'backend',
    requirementIds,
  };
}

const requirements: Requirement[] = [
  makeRequirement('REQ-1', 'backend', 'must'),
  makeRequirement('REQ-2', 'backend', 'could'),
  makeRequirement('REQ-3', 'frontend'),
  makeRequirement('REQ-4', 'backend', 'should'),
];

const sprintPlan: SprintPlan = {
  sprints: [
    { number: 1, goal: 'Base', requirementIds: ['REQ-1', 'REQ-3'] },
    { number: 2, goal: 'Só frontend', requirementIds: ['REQ-3'] },
    { number: 3, goal: 'Resto', requirementIds: ['REQ-2', 'REQ-4'] },
  ],
};

describe('buildBacklogForLayer', () => {
  it('faz uma chamada por sprint que tenha requisitos da camada, só com esses requisitos', async () => {
    const complete = jest.fn(async (request: { userPrompt: string }, _schema: ZodType<unknown>) => {
      if (request.userPrompt.startsWith('Sprint 1')) return [makeDraft('BL-1', 1, ['REQ-1'])];
      if (request.userPrompt.startsWith('Sprint 3')) {
        return [makeDraft('BL-1', 3, ['REQ-2']), makeDraft('BL-2', 3, ['REQ-4'])];
      }
      throw new Error(`sprint inesperado: ${request.userPrompt.slice(0, 20)}`);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, sprintPlan, { complete } as any);

    expect(complete).toHaveBeenCalledTimes(2);
    const [firstRequest] = complete.mock.calls[0] as [{ userPrompt: string }];
    expect(firstRequest.userPrompt).toContain('"REQ-1"');
    expect(firstRequest.userPrompt).not.toContain('"REQ-3"');
    expect(firstRequest.userPrompt).not.toContain('"REQ-2"');
    expect(items).toHaveLength(3);
  });

  it('renumera ids por camada, força o sprint do lote e resolve priority pelos requisitos', async () => {
    const complete = jest.fn(async (request: { userPrompt: string }) => {
      if (request.userPrompt.startsWith('Sprint 1')) return [makeDraft('BL-1', 99, ['REQ-1'])];
      return [makeDraft('BL-1', 3, ['REQ-2']), makeDraft('BL-1', 3, ['REQ-4', 'REQ-2'])];
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, sprintPlan, { complete } as any);

    expect(items.map((item) => item.id)).toEqual(['BL-001', 'BL-002', 'BL-003']);
    expect(items.map((item) => item.sprint)).toEqual([1, 3, 3]);
    expect(items.map((item) => item.priority)).toEqual(['must', 'could', 'should']);
  });

  it('divide sprints grandes em lotes de no máximo 20 requisitos', async () => {
    const many = Array.from({ length: 45 }, (_, i) => makeRequirement(`REQ-${i + 1}`, 'backend'));
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'Tudo', requirementIds: many.map((r) => r.id) }] };
    const complete = jest.fn(async (request: { userPrompt: string }) => {
      const ids = [...request.userPrompt.matchAll(/"id":"(REQ-\d+)"/g)].map((m) => m[1] as string);
      return [makeDraft('BL-1', 1, ids.slice(0, 1))];
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', many, plan, { complete } as any);

    expect(complete).toHaveBeenCalledTimes(3);
    const sizes = complete.mock.calls.map(([req]) => ((req as { userPrompt: string }).userPrompt.match(/"id":"REQ-/g) ?? []).length);
    expect(sizes).toEqual([20, 20, 5]);
    expect(items).toHaveLength(3);
  });

  it('retorna vazio sem chamar a IA quando a camada não tem requisitos em nenhum sprint', async () => {
    const complete = jest.fn(async () => []);
    const onlyBackend = requirements.filter((r) => r.layer === 'backend');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('frontend', onlyBackend, sprintPlan, { complete } as any);

    expect(items).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});
