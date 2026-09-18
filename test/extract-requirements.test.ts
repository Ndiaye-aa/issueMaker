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
    effort: 'm',
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

describe('extractRequirements — esforço', () => {
  it('o prompt de extração pede o campo effort com a escala', async () => {
    const complete = jest.fn(async () => []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await extractRequirements('## S\nconteúdo', { complete } as any);
    const [request] = complete.mock.calls[0] as [{ systemPrompt: string }];
    expect(request.systemPrompt).toContain('"effort"');
    expect(request.systemPrompt).toContain('"xl"');
  });
});

describe('extractRequirements — dependências e paralelismo', () => {
  it('descarta dependências que apontam para fora do chunk e auto-referências', () => {
    const extracted = [
      { ...makeRequirement('REQ-1', 'A'), dependencies: ['REQ-1', 'REQ-42'] },
      { ...makeRequirement('REQ-2', 'B'), dependencies: ['REQ-1', 'REQ-1'] },
    ];

    const unique = ensureUniqueIds(extracted, new Set());

    expect(unique[0]?.dependencies).toEqual([]);
    expect(unique[1]?.dependencies).toEqual(['REQ-1']);
  });

  it('extrai chunks em paralelo e renumera na ordem do documento', async () => {
    const text = '## A\nconteúdo A\n## B\nconteúdo B\n## C\nconteúdo C\n';
    const complete = jest.fn(async (request: { userPrompt: string }, schema: ZodType<unknown>) => {
      if (schema !== RequirementArraySchema) return { same: false };
      const section = /Seção do SDD: "(\w)"/.exec(request.userPrompt)?.[1] ?? '?';
      // Chunk A termina por último: a ordem de chegada não pode afetar a numeração.
      await new Promise((resolve) => setTimeout(resolve, section === 'A' ? 30 : 1));
      return [
        { ...makeRequirement('REQ-1', `${section} um`), dependencies: [] },
        { ...makeRequirement('REQ-2', `${section} dois`), dependencies: ['REQ-1'] },
      ];
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requirements = await extractRequirements(text, { complete } as any);

    expect(requirements.map((r) => r.title)).toEqual(['A um', 'A dois', 'B um', 'B dois', 'C um', 'C dois']);
    expect(requirements.map((r) => r.id)).toEqual(['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-5', 'REQ-6']);
    expect(requirements.map((r) => r.dependencies)).toEqual([[], ['REQ-1'], [], ['REQ-3'], [], ['REQ-5']]);
    // A lista de ids já usados não é mais enviada: cada chunk é independente.
    for (const [request] of complete.mock.calls as [{ userPrompt: string }][]) {
      expect(request.userPrompt).not.toContain('IDs já usados');
    }
  });

  it('ao remover uma duplicata, redireciona dependências para o requisito mantido', async () => {
    const extracted = [
      makeRequirement('REQ-1', 'Login de usuário'),
      makeRequirement('REQ-2', 'Login de usuário'),
      { ...makeRequirement('REQ-3', 'Logout'), dependencies: ['REQ-2'] },
    ];
    const complete = jest.fn(async (_request: unknown, schema: ZodType<unknown>) =>
      schema === RequirementArraySchema ? extracted : { same: true },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requirements = await extractRequirements('## S\nconteúdo', { complete } as any);

    expect(requirements.map((r) => r.id)).toEqual(['REQ-1', 'REQ-3']);
    expect(requirements[1]?.dependencies).toEqual(['REQ-1']);
  });
});
