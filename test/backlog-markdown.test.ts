import type { BacklogItem } from '../src/schemas/backlog-item.js';
import { parseBacklogMarkdown, parseRequirementIdsFromBody, renderBacklogItemMarkdown, renderBacklogMarkdown } from '../src/render/backlog-markdown.js';

const items: BacklogItem[] = [
  {
    id: 'BL-001',
    epic: 'Autenticação',
    type: 'bug',
    priority: 'must',
    title: 'Corrigir erro 500 no login com senha expirada',
    description: 'O login retorna erro 500 em vez de uma mensagem clara.',
    expectedBehavior: 'Deve retornar 401 com mensagem "senha expirada".',
    reproSteps: ['Criar usuário com senha expirada', 'Tentar fazer login'],
    environment: 'Chrome 128 / Ubuntu 24.04',
    acceptanceCriteria: ['Retorna HTTP 401', 'Mensagem de erro clara exibida'],
    technicalSpecificity: {
      httpCodes: ['401', '500'],
      fields: ['password', 'passwordExpiresAt'],
      limits: 'senha expira em 90 dias',
      needsClarification: true,
      clarificationNote: 'Definir se a mensagem deve diferenciar senha expirada de senha errada',
    },
    labels: ['bug', 'auth'],
    sprint: 1,
    layer: 'backend',
    requirementIds: ['REQ-001', 'REQ-002'],
    dependsOn: [],
  },
  {
    id: 'BL-002',
    epic: 'Relatórios',
    type: 'feature',
    priority: 'could',
    title: 'Exportar relatório de vendas em PDF',
    description: 'Permitir que o usuário exporte o relatório de vendas em PDF.',
    expectedBehavior: 'Um PDF é gerado e baixado ao clicar em "Exportar".',
    acceptanceCriteria: ['Botão "Exportar" visível', 'PDF gerado com dados corretos'],
    technicalSpecificity: { httpCodes: [], fields: [], limits: null, needsClarification: false, clarificationNote: null },
    labels: [],
    sprint: 2,
    layer: 'frontend',
    requirementIds: [],
    dependsOn: ['REQ-001', 'REQ-007'],
  },
  {
    id: 'BL-003',
    epic: 'Relatórios',
    type: 'feature',
    priority: 'should',
    title: 'Agendar envio semanal do relatório',
    description: 'Item antigo, sem bloco de especificidade técnica.',
    expectedBehavior: 'Relatório enviado toda segunda-feira às 8h.',
    acceptanceCriteria: ['E-mail enviado às 8h'],
    labels: ['reports'],
    sprint: 2,
    layer: 'backend',
    requirementIds: ['REQ-009'],
    dependsOn: [],
  },
];

describe('backlog markdown round-trip', () => {
  it('renderiza e faz o parse de volta sem perda de campos', () => {
    const markdown = renderBacklogMarkdown(items);
    const parsed = parseBacklogMarkdown(markdown);

    expect(parsed).toEqual(items);
  });

  it('não inclui a seção "Passos para reproduzir" para itens que não são bugs', () => {
    const markdown = renderBacklogMarkdown([items[1]!]);
    expect(markdown).not.toContain('Passos para reproduzir');
  });

  it('não inclui a linha "Ambiente" quando não especificado', () => {
    const markdown = renderBacklogMarkdown([items[1]!]);
    expect(markdown).not.toContain('**Ambiente:**');
  });

  it('omite a linha "Labels" quando o item não tem labels livres', () => {
    expect(renderBacklogMarkdown([items[1]!])).not.toContain('**Labels:**');
    expect(renderBacklogMarkdown([items[0]!])).toContain('**Labels:** `bug`, `auth`');
  });

  it('inclui a rastreabilidade até os requisitos de origem quando presente', () => {
    const markdown = renderBacklogMarkdown([items[0]!]);
    expect(markdown).toContain('**Rastreabilidade:** REQ-001, REQ-002');
  });

  it('omite a linha de rastreabilidade quando não há requisitos associados', () => {
    const markdown = renderBacklogMarkdown([items[1]!]);
    expect(markdown).not.toContain('**Rastreabilidade:**');
  });

  it('inclui a linha de prioridade', () => {
    const markdown = renderBacklogMarkdown([items[0]!]);
    expect(markdown).toContain('**Prioridade:** must');
  });

  it('assume prioridade "should" ao fazer parse de um backlog antigo sem a linha de prioridade', () => {
    const markdown = renderBacklogMarkdown([items[1]!]).replace('**Prioridade:** could\n', '');
    const [parsed] = parseBacklogMarkdown(markdown);
    expect(parsed?.priority).toBe('should');
  });
});

describe('seção "Especificidade técnica"', () => {
  it('renderiza códigos, campos, limites e a decisão pendente', () => {
    const markdown = renderBacklogMarkdown([items[0]!]);
    expect(markdown).toContain(
      [
        '**Especificidade técnica:**',
        '- Códigos HTTP: 401, 500',
        '- Campos: `password`, `passwordExpiresAt`',
        '- Limites: senha expira em 90 dias',
        '- Precisa de esclarecimento: sim — Definir se a mensagem deve diferenciar senha expirada de senha errada',
      ].join('\n'),
    );
  });

  it('omite linhas vazias do bloco e marca "não" quando não há decisão pendente', () => {
    const markdown = renderBacklogMarkdown([items[1]!]);
    expect(markdown).toContain('**Especificidade técnica:**\n- Precisa de esclarecimento: não');
    expect(markdown).not.toContain('- Códigos HTTP:');
    expect(markdown).not.toContain('- Campos:');
    expect(markdown).not.toContain('- Limites:');
  });

  it('backlog antigo sem a seção faz parse com technicalSpecificity ausente', () => {
    const markdown = renderBacklogMarkdown([items[2]!]);
    expect(markdown).not.toContain('Especificidade técnica');
    const [parsed] = parseBacklogMarkdown(markdown);
    expect(parsed?.technicalSpecificity).toBeUndefined();
    expect(parsed?.acceptanceCriteria).toEqual(['E-mail enviado às 8h']);
  });
});

describe('linha "Depende de"', () => {
  it('no arquivo de backlog, cita os ids de requisito e é omitida sem dependências', () => {
    expect(renderBacklogMarkdown([items[1]!])).toContain('**Prioridade:** could\n**Depende de:** REQ-001, REQ-007\n');
    expect(renderBacklogMarkdown([items[0]!])).not.toContain('**Depende de:**');
  });

  it('no corpo da issue, vira #N quando resolvido e marca o que não foi publicado', () => {
    const body = renderBacklogItemMarkdown(items[1]!, { issueNumberByRequirementId: new Map([['REQ-001', 12]]) });
    expect(body).toContain('**Depende de:** #12, REQ-007 (não publicado)');
  });

  it('grava dependsOn no comentário de metadados e faz parse de volta', () => {
    const markdown = renderBacklogMarkdown([items[1]!]);
    expect(markdown).toContain('requirementIds="" dependsOn="REQ-001,REQ-007"');
    expect(parseBacklogMarkdown(markdown)[0]?.dependsOn).toEqual(['REQ-001', 'REQ-007']);
  });

  it('backlog antigo sem dependsOn no comentário faz parse com lista vazia', () => {
    const markdown = renderBacklogMarkdown([items[0]!]).replace(' dependsOn=""', '');
    expect(markdown).not.toContain('dependsOn');
    expect(parseBacklogMarkdown(markdown)[0]?.dependsOn).toEqual([]);
  });

  it('parseRequirementIdsFromBody lê os ids do corpo de uma issue publicada', () => {
    const body = renderBacklogItemMarkdown(items[0]!, { issueNumberByRequirementId: new Map() });
    expect(parseRequirementIdsFromBody(body)).toEqual(['REQ-001', 'REQ-002']);
    expect(parseRequirementIdsFromBody('sem metadados')).toEqual([]);
    expect(parseRequirementIdsFromBody(null)).toEqual([]);
  });
});
