import { formatLabel, getLabelColor, hashShade, normalizeLabelName, parseLabel } from '../src/publish/labels.js';

describe('normalizeLabelName', () => {
  it('remove acentos e converte para minúsculo', () => {
    expect(normalizeLabelName('Autenticação')).toBe('autenticacao');
  });

  it('troca espaços e símbolos por hífen, colapsando repetições', () => {
    expect(normalizeLabelName('Login   via SSO!!')).toBe('login-via-sso');
  });

  it('remove hífens nas pontas', () => {
    expect(normalizeLabelName('  -feature- ')).toBe('feature');
  });

  it('trunca para 20 caracteres por padrão, sem deixar hífen pendurado', () => {
    const result = normalizeLabelName('uma-funcionalidade-muito-longa-de-verdade');
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe('uma-funcionalidade-m');
    expect(normalizeLabelName('abcdefghijklmnopqrs-tuv')).toBe('abcdefghijklmnopqrs');
  });

  it('aceita um limite diferente', () => {
    expect(normalizeLabelName('uma-funcionalidade-muito-longa-de-verdade', 40)).toBe('uma-funcionalidade-muito-longa-de-verdad');
  });
});

describe('formatLabel', () => {
  it('usa o formato "dimensão: valor" em minúsculo', () => {
    expect(formatLabel('priority', 'must')).toBe('priority: must');
    expect(formatLabel('status', 'needs-clarification')).toBe('status: needs-clarification');
  });

  it('tipo usa o prefixo em português e anexa o emoji do valor', () => {
    expect(formatLabel('type', 'feature')).toBe('tipo: feature 🔵');
    expect(formatLabel('type', 'bug')).toBe('tipo: bug 🔴');
    expect(formatLabel('type', 'refactor')).toBe('tipo: refactor 🟠');
    expect(formatLabel('type', 'docs')).toBe('tipo: docs 🟢');
  });

  it('tipo sem emoji definido (tech-debt) não anexa nada', () => {
    expect(formatLabel('type', 'tech-debt')).toBe('tipo: tech-debt');
  });

  it('remove a numeração da seção do SDD na área e permite até 40 caracteres de valor', () => {
    expect(formatLabel('area', '4.3 Modelo de dados')).toBe('area: modelo-de-dados');
    expect(formatLabel('area', '12. Integração com gateway de pagamento e conciliação')).toBe(
      'area: integracao-com-gateway-de-pagamento-e-co',
    );
    expect(formatLabel('area', '4.3 Modelo de dados').length).toBeLessThanOrEqual(50);
  });

  it('devolve string vazia quando o valor não tem conteúdo', () => {
    expect(formatLabel('area', '4.3')).toBe('');
  });

  it('faz o parse de volta, aceitando o prefixo novo e o legado', () => {
    expect(parseLabel('tipo: bug 🔴')).toEqual({ dimension: 'type', value: 'bug' });
    expect(parseLabel('type: bug')).toEqual({ dimension: 'type', value: 'bug' });
    expect(parseLabel('sdd-bot')).toBeUndefined();
  });
});

describe('getLabelColor — famílias por dimensão', () => {
  it('tipo:* com uma cor distinta por valor', () => {
    const colors = ['feature', 'bug', 'tech-debt', 'refactor', 'docs'].map((value) =>
      getLabelColor(`tipo: ${value}`),
    );
    expect(colors).toEqual(['1D76DB', '0052CC', '5EA0F5', 'FB8C00', '90EE90']);
    expect(new Set(colors).size).toBe(5);
  });

  it('aceita o prefixo legado "type:" com o mesmo resultado', () => {
    expect(getLabelColor('type: bug')).toBe(getLabelColor('tipo: bug 🔴'));
  });

  it('priority:* na família vermelho/laranja', () => {
    expect(getLabelColor('priority: must')).toBe('B60205');
    expect(getLabelColor('priority: should')).toBe('D93F0B');
    expect(getLabelColor('priority: could')).toBe('F9A38A');
  });

  it('layer:* na família roxa', () => {
    expect(getLabelColor('layer: frontend')).toBe('5319E7');
    expect(getLabelColor('layer: backend')).toBe('8A63D2');
  });

  it('status e marcador do bot têm cores fixas', () => {
    expect(getLabelColor('status: needs-clarification')).toBe('FBCA04');
    expect(getLabelColor('sdd-bot')).toBe('EDEDED');
  });

  it('area:* usa uma única cor neutra, igual para qualquer módulo', () => {
    const values = ['autenticacao', 'relatorios', 'pagamentos', 'modelo-de-dados'];
    const colors = values.map((value) => getLabelColor(`area: ${value}`));
    expect(new Set(colors).size).toBe(1);
    expect(colors[0]).toMatch(/^[0-9A-F]{6}$/);
  });

  it('hashShade é estável para a mesma entrada', () => {
    expect(hashShade('x')).toBe(hashShade('x'));
  });
});
