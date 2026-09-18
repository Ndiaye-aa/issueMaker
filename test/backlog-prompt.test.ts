import { BACKLOG_SYSTEM_PROMPT, buildBacklogBatchRequest, buildBacklogRequest } from '../src/ai/prompts/backlog.js';
import type { Requirement } from '../src/schemas/requirement.js';

const requirement: Requirement = {
  id: 'REQ-007',
  title: 'Recuperação de senha por e-mail',
  description: 'O sistema deve permitir recuperar a senha por e-mail.',
  layer: 'shared',
  priority: 'should',
  effort: 's',
  dependencies: ['REQ-001'],
  sourceSection: '4.2 Autenticação',
};
const sprint = { number: 2, goal: 'Autenticação completa de ponta a ponta', requirementIds: ['REQ-007'] };

describe('buildBacklogRequest', () => {
  it('system prompt contém as 5 regras, é enxuto e não repete o formato de saída (imposto pelo JSON Schema)', () => {
    for (const rule of ['REGRA 1 — DESCRIÇÃO', 'REGRA 2 — CRITÉRIOS DE ACEITE', 'REGRA 3 — CASOS NEGATIVOS', 'REGRA 4 — ESPECIFICIDADE TÉCNICA', 'REGRA 5 — TÍTULO']) {
      expect(BACKLOG_SYSTEM_PROMPT).toContain(rule);
    }
    expect(BACKLOG_SYSTEM_PROMPT).toContain('needsClarification: true');
    expect(BACKLOG_SYSTEM_PROMPT).toContain('Máximo 70 caracteres');
    expect(BACKLOG_SYSTEM_PROMPT).toContain('✅ "Validar formato de e-mail no cadastro de usuário"');
    expect(BACKLOG_SYSTEM_PROMPT).not.toMatch(/"epic"|"labels"|"sprint"|"requirementIds"/);
    // Sem o bloco "FORMATO DE SAÍDA" (redundante com o JSON Schema da saída estruturada).
    expect(BACKLOG_SYSTEM_PROMPT).not.toContain('FORMATO DE SAÍDA');
    expect(BACKLOG_SYSTEM_PROMPT.length).toBeLessThan(3200);
  });

  it('user prompt segue o bloco [USER] com requisito e contexto', () => {
    const request = buildBacklogRequest('backend', requirement, sprint);

    expect(request.systemPrompt).toBe(BACKLOG_SYSTEM_PROMPT);
    expect(request.temperature).toBe(0.2);
    expect(request.userPrompt).toContain('Requisito original: """Recuperação de senha por e-mail. O sistema deve permitir recuperar a senha por e-mail."""');
    expect(request.userPrompt).toContain('Sprint 2 — objetivo: Autenticação completa de ponta a ponta.');
    expect(request.userPrompt).toContain('Camada: backend.');
    expect(request.userPrompt).toContain('transversal');
    expect(request.userPrompt).toContain('Prioridade (MoSCoW): should.');
    expect(request.userPrompt).toContain('Esforço estimado: s.');
    expect(request.userPrompt).toContain('Seção do SDD de origem: 4.2 Autenticação.');
    expect(request.userPrompt).toContain('Dependências: REQ-001.');
  });

  it('não menciona "shared" para requisito da própria camada e lista "nenhuma" sem dependências', () => {
    const request = buildBacklogRequest('frontend', { ...requirement, layer: 'frontend', dependencies: [] }, sprint);
    expect(request.userPrompt).not.toContain('transversal');
    expect(request.userPrompt).toContain('Dependências: nenhuma.');
  });
});

describe('buildBacklogBatchRequest', () => {
  const other: Requirement = {
    ...requirement,
    id: 'REQ-008',
    title: 'Bloqueio de conta após tentativas',
    description: 'O sistema deve bloquear a conta após 5 tentativas de login inválidas.',
    layer: 'backend',
    dependencies: [],
  };

  it('usa o mesmo system prompt e lista cada requisito com seu id entre colchetes', () => {
    const request = buildBacklogBatchRequest('backend', [requirement, other], sprint);

    expect(request.systemPrompt).toBe(BACKLOG_SYSTEM_PROMPT);
    expect(request.temperature).toBe(0.2);
    expect(request.userPrompt).toContain('Sprint 2 — objetivo: Autenticação completa de ponta a ponta.');
    expect(request.userPrompt).toContain('[REQ-007] Requisito: """Recuperação de senha por e-mail. O sistema deve permitir recuperar a senha por e-mail."""');
    expect(request.userPrompt).toContain('[REQ-008] Requisito: """Bloqueio de conta após tentativas. O sistema deve bloquear a conta após 5 tentativas de login inválidas."""');
    expect(request.userPrompt).toContain('requirementId');
    expect(request.userPrompt).toContain('2 requisitos abaixo');
  });

  it('mantém a nota de "shared" e as dependências por requisito dentro do lote', () => {
    const request = buildBacklogBatchRequest('backend', [requirement, other], sprint);
    const [reqBlock, otherBlock] = request.userPrompt.split('\n\n').slice(-2);

    expect(reqBlock).toContain('transversal');
    expect(reqBlock).toContain('Dependências: REQ-001.');
    expect(otherBlock).not.toContain('transversal');
    expect(otherBlock).toContain('Dependências: nenhuma.');
  });
});
