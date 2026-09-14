import { auditSprintPlan, formatSprintSummary, sprintLoads } from '../src/plan/audit-sprint-plan.js';
import type { Requirement } from '../src/schemas/requirement.js';

function req(id: string, effort: Requirement['effort'], priority: Requirement['priority'] = 'must', dependencies: string[] = []): Requirement {
  return { id, title: id, description: id, layer: 'backend', priority, effort, dependencies, sourceSection: 'S' };
}

describe('auditSprintPlan', () => {
  it('não avisa nada num plano saudável', () => {
    const requirements = [req('R1', 'l'), req('R2', 'm'), req('R3', 'l'), req('R4', 'm')];
    const plan = {
      sprints: [
        { number: 1, goal: 'Login com e-mail e senha funcionando de ponta a ponta', requirementIds: ['R1', 'R2'] },
        { number: 2, goal: 'Recuperação de senha por e-mail funcionando', requirementIds: ['R3', 'R4'] },
      ],
    };
    expect(auditSprintPlan(plan, requirements, 10)).toEqual([]);
  });

  it('aponta goal genérico ou igual a "Sprint N"', () => {
    const requirements = [req('R1', 'm'), req('R2', 'm')];
    const plan = {
      sprints: [
        { number: 1, goal: 'Implementar funcionalidades diversas', requirementIds: ['R1'] },
        { number: 2, goal: 'Sprint 2', requirementIds: ['R2'] },
      ],
    };
    const warnings = auditSprintPlan(plan, requirements);
    expect(warnings).toEqual([expect.stringMatching(/^Sprint 1: goal genérico/), expect.stringMatching(/^Sprint 2: goal genérico/)]);
  });

  it('aponta desbalanceamento acima de 50% entre a mais cheia e a mais vazia e acima de 130% da média', () => {
    const requirements = [req('R1', 'xl'), req('R2', 'xl'), req('R3', 'xs')];
    const plan = {
      sprints: [
        { number: 1, goal: 'Cadastro completo de usuários funcionando', requirementIds: ['R1', 'R2'] },
        { number: 2, goal: 'Ajuste fino do cadastro de usuários', requirementIds: ['R3'] },
      ],
    };
    const warnings = auditSprintPlan(plan, requirements);
    expect(warnings).toEqual([
      expect.stringMatching(/^Carga desbalanceada: Sprint 1 tem 16 pts e Sprint 2 tem 1 pts/),
      expect.stringMatching(/^Sprint 1: 16 pts, acima de 130% da média/),
    ]);
  });

  it('aponta sobrecarga e subutilização em relação à capacidade', () => {
    const requirements = [req('R1', 'xl'), req('R2', 'l'), req('R3', 'xs'), req('R4', 'l'), req('R5', 'l')];
    const plan = {
      sprints: [
        { number: 1, goal: 'Base de autenticação funcionando de ponta a ponta', requirementIds: ['R1', 'R2'] },
        { number: 2, goal: 'Ajuste de mensagem de erro no login', requirementIds: ['R3'] },
        { number: 3, goal: 'Relatórios gerenciais exportáveis em PDF', requirementIds: ['R4', 'R5'] },
      ],
    };
    const warnings = auditSprintPlan(plan, requirements, 10);
    expect(warnings).toContainEqual(expect.stringMatching(/^Sprint 1: sobrecarregada com 13 pts para capacidade de 10 \(R1, R2\)/));
    expect(warnings).toContainEqual(expect.stringMatching(/^Sprint 2: subutilizada — 1 item com 1 pts/));
  });

  it('aponta sprint só de "could" enquanto há "must" pendente sem dependência que justifique', () => {
    // R3 depende de R2 (sprint 2): não poderia vir antes; R2 poderia, e é o que o aviso aponta.
    const requirements = [req('R1', 'l', 'could'), req('R2', 'm', 'must'), req('R3', 'm', 'must', ['R2'])];
    const plan = {
      sprints: [
        { number: 1, goal: 'Melhorias visuais na tela inicial do produto', requirementIds: ['R1'] },
        { number: 2, goal: 'Autenticação obrigatória funcionando de ponta a ponta', requirementIds: ['R2', 'R3'] },
      ],
    };
    const warnings = auditSprintPlan(plan, requirements);
    expect(warnings).toEqual([expect.stringMatching(/^Sprint 1: só itens "could".*\(R2\)/)]);
  });

  it('aponta dependência violada como rede de segurança', () => {
    const requirements = [req('R1', 'm'), req('R2', 'm', 'must', ['R1'])];
    const plan = {
      sprints: [
        { number: 1, goal: 'Tela de perfil consumindo a API de usuários', requirementIds: ['R2'] },
        { number: 2, goal: 'API de usuários com CRUD completo funcionando', requirementIds: ['R1'] },
      ],
    };
    expect(auditSprintPlan(plan, requirements)).toContainEqual('Dependência violada: R2 (Sprint 1) depende de R1 (Sprint 2).');
  });
});

describe('sprintLoads / formatSprintSummary', () => {
  it('soma pontos e conta itens por sprint', () => {
    const requirements = [req('R1', 'l'), req('R2', 's')];
    const [load] = sprintLoads({ sprints: [{ number: 1, goal: 'A', requirementIds: ['R1', 'R2', 'R-inexistente'] }] }, requirements);
    expect(load).toEqual({ number: 1, points: 7, count: 3 });
    expect(formatSprintSummary(load!, 10)).toBe('Sprint 1: 7 pts / 10 (70%) — 3 requisito(s)');
    expect(formatSprintSummary(load!)).toBe('Sprint 1: 7 pts — 3 requisito(s)');
  });
});
