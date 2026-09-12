import { normalizeLabelName, getLabelColor } from '../src/publish/labels.js';

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

  it('trunca para 20 caracteres', () => {
    const result = normalizeLabelName('uma-funcionalidade-muito-longa-de-verdade');
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe('uma-funcionalidade-m');
  });
});

describe('getLabelColor', () => {
  it('retorna azul fixo para labels de sprint', () => {
    expect(getLabelColor('sprint-1')).toBe('0366D6');
    expect(getLabelColor('sprint-23')).toBe('0366D6');
  });

  it('retorna verde fixo para feature', () => {
    expect(getLabelColor('feature')).toBe('28A745');
  });

  it('retorna vermelho fixo para bug', () => {
    expect(getLabelColor('bug')).toBe('D73A4A');
  });

  it('retorna uma cor hex aleatória para labels não padronizadas', () => {
    const color = getLabelColor('tech-debt');
    expect(color).toMatch(/^[0-9a-f]{6}$/i);
  });
});
