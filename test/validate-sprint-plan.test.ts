import type { Requirement } from '../src/schemas/requirement.js';
import {
  capSprintCount,
  pullForward,
  renumberSprints,
  UNPLANNED_SPRINT_GOAL,
  validateAndFixSprintPlan,
} from '../src/plan/validate-sprint-plan.js';

function makeRequirement(id: string, dependencies: string[] = [], effort: Requirement['effort'] = 'm'): Requirement {
  return {
    id,
    title: id,
    description: id,
    layer: 'backend',
    priority: 'must',
    effort,
    dependencies,
    sourceSection: 'Seção',
  };
}

describe('validateAndFixSprintPlan', () => {
  it('mantém um plano já válido inalterado', () => {
    const requirements = [makeRequirement('REQ-001'), makeRequirement('REQ-002', ['REQ-001'])];
    const plan = {
      sprints: [
        { number: 1, goal: 'Fundação', requirementIds: ['REQ-001'] },
        { number: 2, goal: 'Feature', requirementIds: ['REQ-002'] },
      ],
    };

    const fixed = validateAndFixSprintPlan(requirements, plan);

    expect(fixed.sprints).toEqual(plan.sprints);
  });

  it('reordena um requisito alocado antes de sua dependência', () => {
    const requirements = [makeRequirement('REQ-001'), makeRequirement('REQ-002', ['REQ-001'])];
    // Plano inválido gerado pela IA: REQ-002 (que depende de REQ-001) está no sprint 1,
    // e REQ-001 só aparece no sprint 2.
    const invalidPlan = {
      sprints: [
        { number: 1, goal: 'Feature', requirementIds: ['REQ-002'] },
        { number: 2, goal: 'Fundação', requirementIds: ['REQ-001'] },
      ],
    };

    const fixed = validateAndFixSprintPlan(requirements, invalidPlan);

    const sprintOf = (id: string) =>
      fixed.sprints.find((s) => s.requirementIds.includes(id))?.number;

    // A correção junta os dois no mesmo sprint (o de REQ-001); a numeração final é sempre
    // renumerada de forma contígua a partir de 1.
    expect(sprintOf('REQ-001')).toBe(1);
    expect(sprintOf('REQ-002')).toBe(1);
  });

  it('propaga a correção por múltiplos níveis de dependência', () => {
    const requirements = [
      makeRequirement('REQ-001'),
      makeRequirement('REQ-002', ['REQ-001']),
      makeRequirement('REQ-003', ['REQ-002']),
    ];
    const invalidPlan = {
      sprints: [
        { number: 1, goal: 'A', requirementIds: ['REQ-003'] },
        { number: 2, goal: 'B', requirementIds: ['REQ-002'] },
        { number: 3, goal: 'C', requirementIds: ['REQ-001'] },
      ],
    };

    const fixed = validateAndFixSprintPlan(requirements, invalidPlan);
    const sprintOf = (id: string) =>
      fixed.sprints.find((s) => s.requirementIds.includes(id))?.number ?? -1;

    expect(sprintOf('REQ-001')).toBeLessThanOrEqual(sprintOf('REQ-002'));
    expect(sprintOf('REQ-002')).toBeLessThanOrEqual(sprintOf('REQ-003'));
  });

  it('descarta ids inexistentes e aloca requisitos esquecidos num sprint final', () => {
    const requirements = [
      makeRequirement('REQ-1'),
      makeRequirement('REQ-2'),
      makeRequirement('REQ-3'),
    ];
    const plan = {
      sprints: [{ number: 1, goal: 'Base', requirementIds: ['REQ-1', 'REQ-99', 'REQ-1'] }],
    };

    const fixed = validateAndFixSprintPlan(requirements, plan);

    expect(fixed.sprints).toEqual([
      { number: 1, goal: 'Base', requirementIds: ['REQ-1'] },
      { number: 2, goal: UNPLANNED_SPRINT_GOAL, requirementIds: ['REQ-2', 'REQ-3'] },
    ]);
  });
});

describe('rebalanceSprints (via maxPerSprint)', () => {
  it('não altera sprints dentro da capacidade', () => {
    const requirements = [makeRequirement('REQ-1'), makeRequirement('REQ-2')];
    const plan = { sprints: [{ number: 1, goal: 'Base', requirementIds: ['REQ-1', 'REQ-2'] }] };

    expect(validateAndFixSprintPlan(requirements, plan, { maxPerSprint: 2 })).toEqual(plan);
  });

  it('transborda o excedente para o sprint seguinte, criando sprints novos no fim', () => {
    const requirements = Array.from({ length: 7 }, (_, i) => makeRequirement(`REQ-${i + 1}`));
    const plan = {
      sprints: [{ number: 1, goal: 'Tudo', requirementIds: requirements.map((r) => r.id) }],
    };

    const fixed = validateAndFixSprintPlan(requirements, plan, { maxPerSprint: 3 });

    expect(fixed.sprints.map((s) => s.number)).toEqual([1, 2, 3]);
    expect(fixed.sprints.map((s) => s.requirementIds.length)).toEqual([3, 3, 1]);
    const all = fixed.sprints.flatMap((s) => s.requirementIds).sort();
    expect(all).toEqual(requirements.map((r) => r.id).sort());
    expect(fixed.sprints[0]?.goal).toBe('Tudo');
    expect(fixed.sprints[1]?.goal).toBe('Sprint 2');
  });

  it('empurra primeiro os "could", depois "should", mantendo os "must" no sprint original', () => {
    const requirements = [
      { ...makeRequirement('REQ-1'), priority: 'could' as const },
      { ...makeRequirement('REQ-2'), priority: 'must' as const },
      { ...makeRequirement('REQ-3'), priority: 'should' as const },
      { ...makeRequirement('REQ-4'), priority: 'must' as const },
    ];
    const plan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4'] }] };

    const fixed = validateAndFixSprintPlan(requirements, plan, { maxPerSprint: 2 });

    expect(fixed.sprints[0]?.requirementIds).toEqual(['REQ-2', 'REQ-4']);
    expect(fixed.sprints[1]?.requirementIds.sort()).toEqual(['REQ-1', 'REQ-3']);
  });

  it('leva junto os dependentes ao mover um requisito, preservando a ordem de dependências', () => {
    const requirements = [
      { ...makeRequirement('REQ-1'), priority: 'could' as const },
      makeRequirement('REQ-2', ['REQ-1']),
      makeRequirement('REQ-3', ['REQ-2']),
      makeRequirement('REQ-4'),
    ];
    const plan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4'] }] };

    const fixed = validateAndFixSprintPlan(requirements, plan, { maxPerSprint: 3 });

    const sprintOf = (id: string) => fixed.sprints.find((s) => s.requirementIds.includes(id))!.number;
    expect(sprintOf('REQ-4')).toBe(1);
    expect(sprintOf('REQ-1')).toBe(2);
    expect(sprintOf('REQ-2')).toBeGreaterThanOrEqual(sprintOf('REQ-1'));
    expect(sprintOf('REQ-3')).toBeGreaterThanOrEqual(sprintOf('REQ-2'));
    expect(fixed.sprints.every((s) => s.requirementIds.length <= 3)).toBe(true);
  });

  it('o transbordo em cascata respeita a capacidade em todos os sprints', () => {
    const requirements = Array.from({ length: 10 }, (_, i) => makeRequirement(`REQ-${i + 1}`));
    const plan = {
      sprints: [
        { number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-5', 'REQ-6'] },
        { number: 2, goal: 'B', requirementIds: ['REQ-7', 'REQ-8', 'REQ-9', 'REQ-10'] },
      ],
    };

    const fixed = validateAndFixSprintPlan(requirements, plan, { maxPerSprint: 4 });

    expect(fixed.sprints.map((s) => s.requirementIds.length)).toEqual([4, 4, 2]);
    expect(fixed.sprints[1]?.requirementIds).toEqual(['REQ-5', 'REQ-6', 'REQ-7', 'REQ-8']);
  });
});

describe('rebalanceSprints (via capacityPoints)', () => {
  it('transborda por pontos: 3 itens "l" (15 pts) acima da capacidade 10 movem o de menor prioridade', () => {
    const requirements = [
      makeRequirement('REQ-1', [], 'l'),
      { ...makeRequirement('REQ-2', [], 'l'), priority: 'could' as const },
      makeRequirement('REQ-3', [], 'l'),
    ];
    const plan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2', 'REQ-3'] }] };

    const fixed = validateAndFixSprintPlan(requirements, plan, { capacityPoints: 10 });

    expect(fixed.sprints.map((s) => s.requirementIds)).toEqual([['REQ-1', 'REQ-3'], ['REQ-2']]);
  });

  it('respeita o teto de contagem e a capacidade em pontos ao mesmo tempo', () => {
    const requirements = Array.from({ length: 5 }, (_, i) => makeRequirement(`REQ-${i + 1}`, [], 'xs'));
    const plan = { sprints: [{ number: 1, goal: 'A', requirementIds: requirements.map((r) => r.id) }] };

    const fixed = validateAndFixSprintPlan(requirements, plan, { capacityPoints: 100, maxPerSprint: 2 });

    expect(fixed.sprints.map((s) => s.requirementIds.length)).toEqual([2, 2, 1]);
  });

  it('um requisito sozinho acima da capacidade fica na sprint (nunca some)', () => {
    const requirements = [makeRequirement('REQ-1', [], 'xl'), makeRequirement('REQ-2', [], 'xl')];
    const plan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2'] }] };

    const fixed = validateAndFixSprintPlan(requirements, plan, { capacityPoints: 5 });

    expect(fixed.sprints.map((s) => s.requirementIds)).toEqual([['REQ-1'], ['REQ-2']]);
  });

  it('não altera o plano quando há capacidade e o modelo já respeitou', () => {
    const requirements = [makeRequirement('REQ-1', [], 's'), makeRequirement('REQ-2', [], 's')];
    const plan = { sprints: [{ number: 1, goal: 'Base', requirementIds: ['REQ-1', 'REQ-2'] }] };

    expect(validateAndFixSprintPlan(requirements, plan, { capacityPoints: 4 })).toEqual(plan);
  });
});

describe('pullForward', () => {
  it('puxa "must" de sprints posteriores para a sprint mais cedo possível, mesmo estourando a capacidade nominal, respeitando só as dependências', () => {
    const requirements = [
      { ...makeRequirement('REQ-1', [], 's'), priority: 'could' as const },
      makeRequirement('REQ-2', [], 's'),
      makeRequirement('REQ-3', ['REQ-4'], 's'),
      makeRequirement('REQ-4', [], 's'),
    ];
    const plan = {
      sprints: [
        { number: 1, goal: 'A', requirementIds: ['REQ-1'] },
        { number: 2, goal: 'B', requirementIds: ['REQ-2', 'REQ-3'] },
        { number: 3, goal: 'C', requirementIds: ['REQ-4'] },
      ],
    };

    const pulled = pullForward(requirements, plan);

    // REQ-2 e REQ-4 (must, sem dependência pendente) sobem para a sprint 1 mesmo sem limite de
    // capacidade as travar. REQ-3 depende de REQ-4: no momento em que a sprint 1 é processada,
    // REQ-4 ainda não tinha sido puxado (é resolvido depois, na mesma passada), então REQ-3 só
    // não avança mais do que a sprint em que já estava (o algoritmo não refaz a passada).
    expect(pulled.sprints.map((s) => s.requirementIds)).toEqual([['REQ-1', 'REQ-2', 'REQ-4'], ['REQ-3']]);
  });

  it('não puxa "must" cuja dependência ainda está em sprint posterior', () => {
    const requirements = [
      { ...makeRequirement('REQ-1', [], 's'), priority: 'could' as const },
      makeRequirement('REQ-2', ['REQ-3'], 'xs'),
      makeRequirement('REQ-3', [], 'm'),
    ];
    const plan = {
      sprints: [
        { number: 1, goal: 'A', requirementIds: ['REQ-1'] },
        { number: 2, goal: 'B', requirementIds: ['REQ-3'] },
        { number: 3, goal: 'C', requirementIds: ['REQ-2'] },
      ],
    };

    const pulled = pullForward(requirements, plan);

    // REQ-3 (must, sem dependência pendente) sobe para a sprint 1; REQ-2 depende de REQ-3, que
    // só fica satisfeita a partir da sprint 1, então REQ-2 sobe para a sprint 1 também.
    expect(pulled.sprints.map((s) => s.requirementIds)).toEqual([['REQ-1', 'REQ-3', 'REQ-2']]);
  });

  it('validateAndFixSprintPlan renumera sprints esvaziadas pelo pull-forward', () => {
    const requirements = [makeRequirement('REQ-1', [], 'xs'), makeRequirement('REQ-2', [], 'xs')];
    const plan = {
      sprints: [
        { number: 1, goal: 'A', requirementIds: ['REQ-1'] },
        { number: 2, goal: 'B', requirementIds: [] },
        { number: 3, goal: 'C', requirementIds: ['REQ-2'] },
      ],
    };

    const fixed = validateAndFixSprintPlan(requirements, plan, { capacityPoints: 10 });

    expect(fixed.sprints).toEqual([{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2'] }]);
  });
});

describe('renumberSprints', () => {
  it('deixa os números contíguos a partir de 1', () => {
    const plan = { sprints: [{ number: 2, goal: 'A', requirementIds: [] }, { number: 5, goal: 'B', requirementIds: [] }] };
    expect(renumberSprints(plan).sprints.map((s) => s.number)).toEqual([1, 2]);
  });
});

describe('capSprintCount', () => {
  it('não altera planos dentro do limite', () => {
    const plan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1'] }] };
    expect(capSprintCount(plan, 12)).toEqual(plan);
  });

  it('funde o excedente no último sprint permitido, preservando a ordem dos ids', () => {
    const plan = {
      sprints: Array.from({ length: 14 }, (_, i) => ({
        number: i + 1,
        goal: `Sprint ${i + 1}`,
        requirementIds: [`REQ-${i + 1}`],
      })),
    };

    const capped = capSprintCount(plan, 12);

    expect(capped.sprints).toHaveLength(12);
    expect(capped.sprints.map((s) => s.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(capped.sprints[11]!.requirementIds).toEqual(['REQ-12', 'REQ-13', 'REQ-14']);
    expect(capped.sprints[11]!.goal).toBe('Sprint 12');
  });
});

describe('validateAndFixSprintPlan (limite de 12 sprints)', () => {
  it('nunca ultrapassa 12 sprints e mantém a numeração contígua, mesmo sem maxPerSprint/capacityPoints', () => {
    const requirements = Array.from({ length: 20 }, (_, i) => makeRequirement(`REQ-${i + 1}`));
    const plan = {
      sprints: requirements.map((r, i) => ({ number: i + 1, goal: `Sprint ${i + 1}`, requirementIds: [r.id] })),
    };

    const fixed = validateAndFixSprintPlan(requirements, plan);

    expect(fixed.sprints).toHaveLength(12);
    expect(fixed.sprints.map((s) => s.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const all = fixed.sprints.flatMap((s) => s.requirementIds).sort();
    expect(all).toEqual(requirements.map((r) => r.id).sort());
  });
});
