import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { buildAndWriteBacklogs, buildBacklogForLayer, looksLikeEnvironment } from '../src/backlog/build-backlog.js';
import { log } from '../src/cli/logger.js';
import type { BacklogItemDraft } from '../src/schemas/backlog-item.js';
import type { Requirement } from '../src/schemas/requirement.js';
import type { SprintPlan } from '../src/schemas/sprint-plan.js';

function makeRequirement(
  id: string,
  layer: Requirement['layer'],
  priority: Requirement['priority'] = 'must',
  dependencies: string[] = [],
): Requirement {
  return {
    id,
    title: `Requisito ${id}`,
    description: `Descrição do requisito ${id}`,
    layer,
    priority,
    effort: 'm',
    dependencies,
    sourceSection: '4.2 Autenticação',
  };
}

function makeDraft(overrides: Partial<BacklogItemDraft> = {}): BacklogItemDraft {
  return {
    title: 'Validar formato de e-mail no cadastro de usuário',
    type: 'feature',
    description: 'Adicionar validação de formato no campo email do endpoint POST /users, usando regex RFC 5322.',
    expectedBehavior: 'Requisições com email fora do padrão recebem HTTP 422 e a mensagem "email inválido".',
    acceptanceCriteria: [
      'Quando o email é válido, então o usuário é criado e a resposta é HTTP 201',
      'Quando o email não tem "@", então a resposta é HTTP 422 com a mensagem "email inválido"',
    ],
    technicalSpecificity: {
      httpCodes: ['201', '422'],
      fields: ['email'],
      limits: null,
      needsClarification: false,
      clarificationNote: null,
    },
    ...overrides,
  };
}

const requirements: Requirement[] = [
  makeRequirement('REQ-1', 'backend', 'must'),
  makeRequirement('REQ-2', 'backend', 'could'),
  makeRequirement('REQ-3', 'frontend'),
  makeRequirement('REQ-4', 'backend', 'should'),
];

const sprintPlan: SprintPlan = {
  sprints: [
    { number: 1, goal: 'Base', requirementIds: ['REQ-1', 'REQ-3'] },
    { number: 2, goal: 'Só frontend', requirementIds: ['REQ-3'] },
    { number: 3, goal: 'Resto', requirementIds: ['REQ-2', 'REQ-4'] },
  ],
};

function requirementIdIn(userPrompt: string): string {
  return /Requisito original: """Requisito (REQ-\d+)\./.exec(userPrompt)?.[1] ?? '?';
}

describe('buildBacklogForLayer', () => {
  it('faz uma chamada por requisito da camada, com o requisito e o contexto do sprint no prompt', async () => {
    const complete = jest.fn(async () => makeDraft());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, sprintPlan, { complete } as any);

    expect(complete).toHaveBeenCalledTimes(3);
    const prompts = complete.mock.calls.map(([request]) => (request as { userPrompt: string }).userPrompt);
    expect(prompts.map(requirementIdIn)).toEqual(['REQ-1', 'REQ-2', 'REQ-4']);
    expect(prompts[0]).toContain('Requisito original: """Requisito REQ-1. Descrição do requisito REQ-1"""');
    expect(prompts[0]).toContain('Sprint 1 — objetivo: Base.');
    expect(prompts[0]).toContain('Camada: backend.');
    expect(prompts[0]).not.toContain('REQ-3');
    expect(items).toHaveLength(3);
  });

  it('preenche id, sprint, layer, epic, rastreabilidade e priority localmente, nunca pelo modelo', async () => {
    const complete = jest.fn(async () => makeDraft());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, sprintPlan, { complete } as any);

    expect(items.map((item) => item.id)).toEqual(['BL-001', 'BL-002', 'BL-003']);
    expect(items.map((item) => item.sprint)).toEqual([1, 3, 3]);
    expect(items.map((item) => item.requirementIds)).toEqual([['REQ-1'], ['REQ-2'], ['REQ-4']]);
    expect(items.map((item) => item.priority)).toEqual(['must', 'could', 'should']);
    expect(items.every((item) => item.layer === 'backend')).toBe(true);
    expect(items.every((item) => item.epic === '4.2 Autenticação')).toBe(true);
    expect(items.every((item) => item.labels.length === 0)).toBe(true);
    expect(items[0]?.technicalSpecificity).toEqual(makeDraft().technicalSpecificity);
  });

  it('descarta reproSteps de itens que não são bug e environment vazio ou que só repete contexto', async () => {
    const complete = jest.fn(async () =>
      makeDraft({ reproSteps: ['passo inventado'], environment: 'Frontend — tela de cadastro. Prioridade must. Sprint 1.' }),
    );
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1'] }] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [item] = await buildBacklogForLayer('backend', requirements, plan, { complete } as any);

    expect(item?.reproSteps).toBeUndefined();
    expect(item?.environment).toBeUndefined();
    expect(looksLikeEnvironment('   ')).toBe(false);
    expect(looksLikeEnvironment('Chrome 128 / Ubuntu 24.04')).toBe(true);
    expect(looksLikeEnvironment('Node.js 20 em Docker')).toBe(true);
  });

  it('gera uma chamada por requisito mesmo em sprints grandes', async () => {
    const many = Array.from({ length: 45 }, (_, i) => makeRequirement(`REQ-${i + 1}`, 'backend'));
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'Tudo', requirementIds: many.map((r) => r.id) }] };
    const complete = jest.fn(async () => makeDraft());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', many, plan, { complete } as any);

    expect(complete).toHaveBeenCalledTimes(45);
    expect(items).toHaveLength(45);
    expect(items[44]?.id).toBe('BL-045');
  });

  it('retorna vazio sem chamar a IA quando a camada não tem requisitos em nenhum sprint', async () => {
    const complete = jest.fn(async () => makeDraft());
    const onlyBackend = requirements.filter((r) => r.layer === 'backend');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('frontend', onlyBackend, sprintPlan, { complete } as any);

    expect(items).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('avisa (sem abortar) quando dois itens da camada ficam com o mesmo título', async () => {
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    const complete = jest.fn(async () => makeDraft({ title: 'Validar formato de e-mail no cadastro' }));
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2'] }] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, plan, { complete } as any);

    expect(items).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('título repetido');
    expect(warn.mock.calls[0]?.[0]).toContain('REQ-1');
    expect(warn.mock.calls[0]?.[0]).toContain('REQ-2');
    warn.mockRestore();
  });

  it('quando a geração de um requisito esgota as tentativas, marca só ele para revisão manual em vez de derrubar a camada inteira', async () => {
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    const complete = jest.fn(async (request: { userPrompt: string }) => {
      if (request.userPrompt.includes('REQ-2')) {
        throw new Error('modelo insistiu em título vago após todas as tentativas');
      }
      return makeDraft();
    });
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2'] }] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, plan, { complete } as any);

    expect(items).toHaveLength(2);
    const failed = items.find((item) => item.requirementIds.includes('REQ-2'))!;
    expect(failed.technicalSpecificity?.needsClarification).toBe(true);
    expect(failed.technicalSpecificity?.clarificationNote).toContain('Geração automática falhou');
    const ok = items.find((item) => item.requirementIds.includes('REQ-1'))!;
    expect(ok.technicalSpecificity?.needsClarification).toBe(false);
    expect(warn.mock.calls.some(([message]) => String(message).includes('revisão manual'))).toBe(true);
    warn.mockRestore();
  });
});

describe('buildBacklogForLayer — dependências', () => {
  it('deriva dependsOn de Requirement.dependencies, descartando auto-referência e ids desconhecidos', async () => {
    const reqs = [
      makeRequirement('REQ-1', 'backend'),
      makeRequirement('REQ-2', 'frontend', 'must', ['REQ-1', 'REQ-2', 'REQ-99', 'REQ-1']),
    ];
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2'] }] };
    const complete = jest.fn(async () => makeDraft());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [item] = await buildBacklogForLayer('frontend', reqs, plan, { complete } as any);

    expect(item?.requirementIds).toEqual(['REQ-2']);
    expect(item?.dependsOn).toEqual(['REQ-1']);
  });

  it('avisa (sem abortar) quando os requisitos da camada formam um ciclo', async () => {
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    const reqs = [makeRequirement('REQ-1', 'backend', 'must', ['REQ-2']), makeRequirement('REQ-2', 'backend', 'must', ['REQ-1'])];
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2'] }] };
    const complete = jest.fn(async () => makeDraft());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', reqs, plan, { complete } as any);

    expect(items).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ciclo de dependências.*REQ-1 → REQ-2 → REQ-1/));
    warn.mockRestore();
  });
});

describe('buildBacklogForLayer — lotes (batchSize > 1)', () => {
  function requirementIdsIn(userPrompt: string): string[] {
    return [...userPrompt.matchAll(/\[(REQ-\d+)\]/g)].map((m) => m[1]!);
  }

  it('agrupa até batchSize requisitos da mesma sprint numa única chamada, sem misturar sprints', async () => {
    const complete = jest.fn(async (request: { userPrompt: string }) => {
      const ids = requirementIdsIn(request.userPrompt);
      // Lote de 1 requisito continua indo pelo caminho de chamada única (sem colchetes/array).
      if (ids.length === 0) return makeDraft();
      return ids.map((requirementId) => ({ ...makeDraft(), requirementId }));
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, sprintPlan, { complete } as any, {
      batchSize: 4,
    });

    // sprint 1 (REQ-1): lote de 1, vai pelo caminho de chamada única (sem colchetes).
    // sprint 3 (REQ-2, REQ-4): lote de 2, vai pelo caminho de lote.
    expect(complete).toHaveBeenCalledTimes(2);
    const prompts = complete.mock.calls.map(([request]) => (request as { userPrompt: string }).userPrompt);
    expect(prompts[0]).toContain('Requisito original: """Requisito REQ-1.');
    expect(requirementIdsIn(prompts[1]!)).toEqual(['REQ-2', 'REQ-4']);
    expect(items.map((item) => item.requirementIds[0])).toEqual(['REQ-1', 'REQ-2', 'REQ-4']);
  });

  it('fatia um sprint maior que batchSize em vários lotes', async () => {
    const many = Array.from({ length: 5 }, (_, i) => makeRequirement(`REQ-${i + 1}`, 'backend'));
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'Tudo', requirementIds: many.map((r) => r.id) }] };
    const complete = jest.fn(async (request: { userPrompt: string }) => {
      const ids = requirementIdsIn(request.userPrompt);
      // Lote de 1 requisito continua indo pelo caminho de chamada única (sem colchetes/array).
      if (ids.length === 0) return makeDraft();
      return ids.map((requirementId) => ({ ...makeDraft(), requirementId }));
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', many, plan, { complete } as any, { batchSize: 2 });

    expect(complete).toHaveBeenCalledTimes(3); // lotes de 2, 2, 1
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.requirementIds[0])).toEqual(['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-5']);
  });

  it('remonta cada item pelo requirementId, mesmo com a resposta em ordem diferente da pedida', async () => {
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2'] }] };
    const complete = jest.fn(async () => [
      { ...makeDraft({ title: 'Implementar item do requisito dois' }), requirementId: 'REQ-2' },
      { ...makeDraft({ title: 'Implementar item do requisito um' }), requirementId: 'REQ-1' },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', requirements, plan, { complete } as any, { batchSize: 2 });

    // Mesmo com a IA respondendo REQ-2 antes de REQ-1, o item de saída segue a ordem do lote.
    expect(items.map((item) => [item.requirementIds[0], item.title])).toEqual([
      ['REQ-1', 'Implementar item do requisito um'],
      ['REQ-2', 'Implementar item do requisito dois'],
    ]);
  });

  it('batchSize 1 (default) continua fazendo uma chamada por requisito, sem requirementId no prompt', async () => {
    const complete = jest.fn(async () => makeDraft());
    const plan: SprintPlan = { sprints: [{ number: 1, goal: 'A', requirementIds: ['REQ-1'] }] };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await buildBacklogForLayer('backend', requirements, plan, { complete } as any);

    expect(complete).toHaveBeenCalledTimes(1);
    const prompt = (complete.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(prompt).toContain('Requisito original: """Requisito REQ-1.');
    expect(prompt).not.toContain('[REQ-1]');
  });
});

describe('buildBacklogForLayer — requisitos shared', () => {
  const withShared: Requirement[] = [
    makeRequirement('REQ-1', 'backend'),
    makeRequirement('REQ-2', 'shared'),
    makeRequirement('REQ-3', 'frontend'),
  ];
  const plan: SprintPlan = {
    sprints: [{ number: 1, goal: 'Base', requirementIds: ['REQ-1', 'REQ-2', 'REQ-3'] }],
  };

  it('inclui os requisitos shared no backlog de backend, com aviso só no prompt deles', async () => {
    const complete = jest.fn(async () => makeDraft());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', withShared, plan, { complete } as any);

    const prompts = complete.mock.calls.map(([request]) => (request as { userPrompt: string }).userPrompt);
    expect(prompts.map(requirementIdIn)).toEqual(['REQ-1', 'REQ-2']);
    expect(prompts[0]).not.toMatch(/transversal/);
    expect(prompts[1]).toMatch(/transversal/);
    expect(items.map((item) => item.requirementIds[0])).toEqual(['REQ-1', 'REQ-2']);
    expect(items.every((item) => item.layer === 'backend')).toBe(true);
  });

  it('não envia os requisitos shared para o backlog de frontend', async () => {
    const complete = jest.fn(async () => makeDraft());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('frontend', withShared, plan, { complete } as any);

    const prompts = complete.mock.calls.map(([request]) => (request as { userPrompt: string }).userPrompt);
    expect(prompts.map(requirementIdIn)).toEqual(['REQ-3']);
    expect(items.map((item) => item.requirementIds[0])).toEqual(['REQ-3']);
  });

  it('mantém a numeração BL-xxx na ordem sprint → requisito mesmo com respostas fora de ordem', async () => {
    const many = Array.from({ length: 5 }, (_, i) => makeRequirement(`REQ-${i + 1}`, 'backend'));
    const twoSprints: SprintPlan = {
      sprints: [
        { number: 1, goal: 'A', requirementIds: ['REQ-1', 'REQ-2', 'REQ-3'] },
        { number: 2, goal: 'B', requirementIds: ['REQ-4', 'REQ-5'] },
      ],
    };
    const complete = jest.fn(async (request: { userPrompt: string }) => {
      const id = requirementIdIn(request.userPrompt);
      // O primeiro requisito demora mais: sem reordenação, ele terminaria por último.
      await new Promise((resolve) => setTimeout(resolve, id === 'REQ-1' ? 30 : 1));
      return makeDraft({ title: `Implementar requisito ${id} no módulo de cadastro` });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await buildBacklogForLayer('backend', many, twoSprints, { complete } as any);

    expect(items.map((item) => [item.id, item.sprint, item.requirementIds[0]])).toEqual([
      ['BL-001', 1, 'REQ-1'],
      ['BL-002', 1, 'REQ-2'],
      ['BL-003', 1, 'REQ-3'],
      ['BL-004', 2, 'REQ-4'],
      ['BL-005', 2, 'REQ-5'],
    ]);
  });
});

describe('buildAndWriteBacklogs', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'sdd-bot-build-backlog-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(outDir, { recursive: true, force: true });
  });

  it('grava as duas camadas em disco com conteúdo real mesmo quando um requisito esgota as tentativas de geração', async () => {
    jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    jest.spyOn(log, 'step').mockImplementation(() => undefined);

    const complete = jest.fn(async (request: { userPrompt: string }) => {
      const id = requirementIdIn(request.userPrompt);
      if (id === 'REQ-2') {
        throw new Error('modelo insistiu em critério não verificável após todas as tentativas');
      }
      return makeDraft({ title: `Implementar requisito ${id} no módulo de cadastro` });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildAndWriteBacklogs(requirements, sprintPlan, { complete } as any, outDir);

    expect(result.backend.some((item) => item.requirementIds.includes('REQ-2'))).toBe(true);

    const backendMarkdown = await readFile(join(outDir, 'backlog-backend.md'), 'utf-8');
    const frontendMarkdown = await readFile(join(outDir, 'backlog-frontend.md'), 'utf-8');

    // Nenhum dos dois arquivos fica preso no placeholder de "ainda gerando" — o bug original
    // era exatamente esse: 1 lote falho derrubava a geração inteira e os arquivos nunca eram
    // sobrescritos com conteúdo de verdade.
    expect(backendMarkdown).not.toContain('_gerando backlog..._');
    expect(frontendMarkdown).not.toContain('_gerando backlog..._');
    expect(backendMarkdown).toContain('### [Sprint');

    expect(backendMarkdown).toContain('Revisar manualmente:');
    expect(backendMarkdown).toContain('Geração automática falhou');

    // REQ-1 e REQ-4 (backend) e REQ-3 (frontend) não falharam: aparecem normalmente, sem o
    // marcador de revisão manual.
    expect(backendMarkdown).toContain('Implementar requisito REQ-1 no módulo de cadastro');
    expect(backendMarkdown).toContain('Implementar requisito REQ-4 no módulo de cadastro');
    expect(frontendMarkdown).toContain('Implementar requisito REQ-3 no módulo de cadastro');
    expect(frontendMarkdown).not.toContain('Revisar manualmente:');
  });
});
