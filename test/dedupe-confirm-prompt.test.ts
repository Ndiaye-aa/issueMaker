import { buildDedupeConfirmRequest } from '../src/ai/prompts/dedupe-confirm.js';
import type { Requirement } from '../src/schemas/requirement.js';

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-1',
    title: 'Login com e-mail e senha',
    description: 'O sistema deve autenticar o usuário via e-mail e senha.',
    layer: 'backend',
    priority: 'must',
    effort: 3,
    sourceSection: '1',
    dependencies: [],
    ...overrides,
  } as Requirement;
}

describe('buildDedupeConfirmRequest', () => {
  it('usa tier "light": decisão binária não precisa do modelo principal', () => {
    const request = buildDedupeConfirmRequest(requirement(), requirement({ id: 'REQ-2' }));
    expect(request.tier).toBe('light');
    expect(request.temperature).toBe(0);
  });

  it('inclui título e descrição dos dois requisitos no user prompt', () => {
    const a = requirement({ title: 'Login A' });
    const b = requirement({ id: 'REQ-2', title: 'Login B' });
    const request = buildDedupeConfirmRequest(a, b);
    expect(request.userPrompt).toContain('Login A');
    expect(request.userPrompt).toContain('Login B');
  });
});
