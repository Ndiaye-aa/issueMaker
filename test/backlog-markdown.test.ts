import type { BacklogItem } from '../src/schemas/backlog-item.js';
import { parseBacklogMarkdown, renderBacklogMarkdown } from '../src/render/backlog-markdown.js';

const items: BacklogItem[] = [
  {
    id: 'BL-001',
    epic: 'Autenticação',
    type: 'bug',
    title: 'Corrigir erro 500 no login com senha expirada',
    description: 'O login retorna erro 500 em vez de uma mensagem clara.',
    expectedBehavior: 'Deve retornar 401 com mensagem "senha expirada".',
    reproSteps: ['Criar usuário com senha expirada', 'Tentar fazer login'],
    environment: 'Chrome 128 / Ubuntu 24.04',
    acceptanceCriteria: ['Retorna HTTP 401', 'Mensagem de erro clara exibida'],
    labels: ['bug', 'auth'],
    sprint: 1,
    layer: 'backend',
    requirementIds: ['REQ-001', 'REQ-002'],
  },
  {
    id: 'BL-002',
    epic: 'Relatórios',
    type: 'feature',
    title: 'Exportar relatório de vendas em PDF',
    description: 'Permitir que o usuário exporte o relatório de vendas em PDF.',
    expectedBehavior: 'Um PDF é gerado e baixado ao clicar em "Exportar".',
    acceptanceCriteria: ['Botão "Exportar" visível', 'PDF gerado com dados corretos'],
    labels: ['feature', 'reports'],
    sprint: 2,
    layer: 'frontend',
    requirementIds: [],
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

  it('inclui a rastreabilidade até os requisitos de origem quando presente', () => {
    const markdown = renderBacklogMarkdown([items[0]!]);
    expect(markdown).toContain('**Rastreabilidade:** REQ-001, REQ-002');
  });

  it('omite a linha de rastreabilidade quando não há requisitos associados', () => {
    const markdown = renderBacklogMarkdown([items[1]!]);
    expect(markdown).not.toContain('**Rastreabilidade:**');
  });
});
