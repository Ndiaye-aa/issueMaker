import { BacklogItemSchema } from '../src/schemas/backlog-item.js';
import { RequirementSchema } from '../src/schemas/requirement.js';
import { SprintPlanSchema } from '../src/schemas/sprint-plan.js';

describe('RequirementSchema', () => {
  it('aceita um requisito válido', () => {
    const result = RequirementSchema.safeParse({
      id: 'REQ-001',
      title: 'Login de usuário',
      description: 'Permitir login com e-mail e senha',
      layer: 'backend',
      priority: 'must',
      dependencies: [],
      sourceSection: 'Seção 4.1',
    });
    expect(result.success).toBe(true);
  });
});

describe('SprintPlanSchema', () => {
  it('aceita um plano de sprints válido', () => {
    const result = SprintPlanSchema.safeParse({
      sprints: [{ number: 1, goal: 'Fundação', requirementIds: ['REQ-001'] }],
    });
    expect(result.success).toBe(true);
  });
});

describe('BacklogItemSchema', () => {
  const base = {
    id: 'BL-001',
    epic: 'Autenticação',
    title: 'Corrigir erro 500 no login com senha expirada',
    description: 'Descrição objetiva',
    expectedBehavior: 'Deve retornar 401 com mensagem clara',
    acceptanceCriteria: ['Retorna 401'],
    labels: ['bug'],
    sprint: 1,
    layer: 'backend' as const,
    requirementIds: ['REQ-001'],
  };

  it('exige reproSteps quando type === bug', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'bug' });
    expect(result.success).toBe(false);
  });

  it('aceita bug com reproSteps preenchido', () => {
    const result = BacklogItemSchema.safeParse({
      ...base,
      type: 'bug',
      reproSteps: ['Fazer login com senha expirada'],
    });
    expect(result.success).toBe(true);
  });

  it('não exige reproSteps para features', () => {
    const result = BacklogItemSchema.safeParse({ ...base, type: 'feature' });
    expect(result.success).toBe(true);
  });
});
