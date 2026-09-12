import type { Requirement } from '../src/schemas/requirement.js';
import { validateAndFixSprintPlan } from '../src/plan/validate-sprint-plan.js';

function makeRequirement(id: string, dependencies: string[] = []): Requirement {
  return {
    id,
    title: id,
    description: id,
    layer: 'backend',
    priority: 'must',
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

    expect(sprintOf('REQ-001')).toBeLessThanOrEqual(sprintOf('REQ-002')!);
    expect(sprintOf('REQ-002')).toBe(2);
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
});
