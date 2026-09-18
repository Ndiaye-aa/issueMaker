import { jest } from '@jest/globals';
import type { ZodType } from 'zod';
import { buildSprintPlan } from '../src/plan/build-sprint-plan.js';
import { SprintGoalsSchema } from '../src/ai/prompts/sprint-goals.js';
import { log } from '../src/cli/logger.js';
import type { Requirement } from '../src/schemas/requirement.js';

function req(id: string, effort: Requirement['effort'], priority: Requirement['priority'] = 'must'): Requirement {
  return { id, title: `Título ${id}`, description: id, layer: 'backend', priority, effort, dependencies: [], sourceSection: 'S' };
}

beforeEach(() => {
  jest.spyOn(log, 'step').mockImplementation(() => undefined);
  jest.spyOn(log, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('buildSprintPlan', () => {
  it('informa capacidade efetiva e mínimo de sprints ao modelo e não reescreve goals quando nada muda', async () => {
    const requirements = [req('R1', 'l'), req('R2', 'xs'), req('R3', 'l')];
    const complete = jest.fn(async (request: { userPrompt: string }, _schema: ZodType<unknown>) => {
      expect(request.userPrompt).toContain('Capacidade efetiva: 10 pontos por sprint. Esforço total: 11 pontos em 3 requisitos (portanto no mínimo 2 sprints).');
      expect(request.userPrompt).toContain('"effort":"l"');
      return {
        sprints: [
          { number: 1, goal: 'Cadastro de usuários funcionando de ponta a ponta', requirementIds: ['R1', 'R2'] },
          { number: 2, goal: 'Relatórios gerenciais disponíveis para download', requirementIds: ['R3'] },
        ],
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await buildSprintPlan(requirements, '2 semanas', { complete } as any, {
      capacity: { nominal: 14, buffer: 0.75 },
      startDate: '2026-09-14',
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(plan.sprints.map((s) => [s.number, s.startDate, s.dueDate])).toEqual([
      [1, '2026-09-14', '2026-09-27'],
      [2, '2026-09-28', '2026-10-11'],
    ]);
    expect(plan.warnings).toBeUndefined();
  });

  it('reescreve os goals das sprints cuja composição mudou no rebalanceamento e grava avisos', async () => {
    const requirements = [req('R1', 'l'), req('R2', 'l'), req('R3', 'l', 'could'), req('R4', 'xs')];
    const complete = jest.fn(async (request: { userPrompt: string }, schema: ZodType<unknown>) => {
      if (schema === SprintGoalsSchema) {
        // R3 transbordou da sprint 1 para a 2: as duas mudaram de composição.
        expect(request.userPrompt).toContain('"number":1');
        expect(request.userPrompt).toContain('"number":2');
        return {
          goals: [
            { number: 1, goal: 'Cadastro e edição de usuários funcionando de ponta a ponta' },
            { number: 2, goal: 'Exclusão de usuários com confirmação funcionando' },
          ],
        };
      }
      return {
        sprints: [
          { number: 1, goal: 'Tudo de uma vez', requirementIds: ['R1', 'R2', 'R3'] },
          { number: 2, goal: 'Auditoria de acessos registrada em log', requirementIds: ['R4'] },
        ],
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await buildSprintPlan(requirements, '2 semanas', { complete } as any, {
      capacity: { nominal: 10, buffer: 1 },
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(plan.sprints.map((s) => s.requirementIds)).toEqual([['R1', 'R2'], ['R3', 'R4']]);
    expect(plan.sprints.map((s) => s.goal)).toEqual([
      'Cadastro e edição de usuários funcionando de ponta a ponta',
      'Exclusão de usuários com confirmação funcionando',
    ]);
    expect(plan.sprints[1]?.startDate).toBeUndefined();
    expect(plan.warnings).toEqual([expect.stringMatching(/^Sprint 1: 10 pts, acima de 130%/)]);
  });

  it('ajusta a capacidade proporcionalmente para caber em no máximo 12 sprints', async () => {
    // 20 requisitos "m" (3 pts cada) = 60 pts. Capacidade nominal de 1 pt/dia deixaria 60
    // sprints; o clamp deve elevar para caber em 12 (ceil(60/12) = 5 pts/sprint).
    const requirements = Array.from({ length: 20 }, (_, i) => req(`R${i + 1}`, 'm'));
    const complete = jest.fn(async (request: { userPrompt: string }, schema: ZodType<unknown>) => {
      if (schema === SprintGoalsSchema) {
        return { goals: [] };
      }
      expect(request.userPrompt).toContain('Máximo de sprints permitido: 12.');
      expect(request.userPrompt).toContain('Capacidade efetiva: 5 pontos por sprint.');
      return {
        sprints: requirements.map((r, i) => ({ number: i + 1, goal: `Sprint ${i + 1}`, requirementIds: [r.id] })),
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await buildSprintPlan(requirements, '1 dia', { complete } as any, {
      capacity: { nominal: 1, buffer: 1 },
    });

    expect(plan.sprints.length).toBeLessThanOrEqual(12);
    const all = plan.sprints.flatMap((s) => s.requirementIds).sort();
    expect(all).toEqual(requirements.map((r) => r.id).sort());
  });

  it('sem duração reconhecível, avisa e sai sem datas', async () => {
    const complete = jest.fn(async () => ({ sprints: [{ number: 1, goal: 'Cadastro completo funcionando de ponta a ponta', requirementIds: ['R1'] }] }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = await buildSprintPlan([req('R1', 'm')], 'um mês', { complete } as any, { startDate: '2026-09-14' });

    expect(plan.sprints[0]?.startDate).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('sem datas'));
  });
});
