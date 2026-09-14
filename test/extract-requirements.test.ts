import type { ZodType } from 'zod';
import { jest } from '@jest/globals';
import { ensureUniqueIds, extractRequirements } from '../src/ingest/extract-requirements.js';
import { RequirementArraySchema, type Requirement } from '../src/schemas/requirement.js';

const sddText = `## Autenticação
O sistema deve permitir login com e-mail e senha.

## Relatórios
O sistema deve exportar relatórios em PDF.
`;

function makeRequirement(id: string, title: string): Requirement {
  return {
    id,
    title,
    description: `Descrição de ${title}`,
    layer: 'backend',
    priority: 'must',
    dependencies: [],
    sourceSection: 'Autenticação',
  };
}

describe('extractRequirements', () => {
  it('extrai, mescla e deduplica requisitos de múltiplos chunks', async () => {
    const responsesBySection: Record<string, Requirement[]> = {
      Autenticação: [makeRequirement('REQ-001', 'Login de usuário')],
      Relatórios: [makeRequirement('REQ-002', 'Exportar relatório em PDF')],
    };

    const fakeAiClient = {
      complete: jest.fn(async (request: { userPrompt: string }, schema: ZodType<unknown>) => {
        if (schema === RequirementArraySchema) {
          const section = Object.keys(responsesBySection).find((title) =>
            request.userPrompt.includes(title),
          );
          return section ? responsesBySection[section] : [];
        }
        return { same: false };
      }),
    };

    const requirements = await extractRequirements(
      sddText,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeAiClient as any,
    );

    expect(RequirementArraySchema.safeParse(requirements).success).toBe(true);
    expect(requirements).toHaveLength(2);
    expect(requirements.map((r) => r.id).sort()).toEqual(['REQ-001', 'REQ-002']);
  });

  it('remove requisitos confirmados como duplicados pela IA', async () => {
    const duplicate = [
      makeRequirement('REQ-001', 'Login de usuário'),
      makeRequirement('REQ-002', 'Login de usuário'),
    ];

    const fakeAiClient = {
      complete: jest.fn(async (_request: unknown, schema: ZodType<unknown>) => {
        if (schema === RequirementArraySchema) {
          return duplicate;
        }
        return { same: true };
      }),
    };

    const requirements = await extractRequirements(
      '## Única\nconteúdo',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeAiClient as any,
    );

    expect(requirements).toHaveLength(1);
  });

  it('retorna array vazio quando o SDD não contém requisitos extraíveis', async () => {
    const fakeAiClient = {
      complete: jest.fn(async () => []),
    };

    const requirements = await extractRequirements(
      '## Só contexto\nEste texto não descreve nenhum requisito de software.',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeAiClient as any,
    );

    expect(requirements).toEqual([]);
  });

  it('renumera ids repetidos entre chunks e reescreve as dependências internas', () => {
    const used = new Set(['REQ-1', 'REQ-2']);
    const extracted = [
      { ...makeRequirement('REQ-1', 'Cadastro'), dependencies: [] },
      { ...makeRequirement('REQ-2', 'Edição'), dependencies: ['REQ-1'] },
      { ...makeRequirement('REQ-7', 'Exclusão'), dependencies: ['REQ-2'] },
    ];

    const unique = ensureUniqueIds(extracted, used);

    expect(unique.map((r) => r.id)).toEqual(['REQ-3', 'REQ-4', 'REQ-7']);
    expect(unique[1]?.dependencies).toEqual(['REQ-3']);
    expect(unique[2]?.dependencies).toEqual(['REQ-4']);
    expect([...used].sort()).toEqual(['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-7']);
  });
});
