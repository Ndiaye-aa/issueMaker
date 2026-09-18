import { jest } from '@jest/globals';
import type { BacklogItem } from '../src/schemas/backlog-item.js';
import type { SprintPlan } from '../src/schemas/sprint-plan.js';
import type { GithubPublisherLike, MilestoneSpec } from '../src/publish/publish-backlog.js';
import { labelsForItem, milestoneSpecs, publishBacklog } from '../src/publish/publish-backlog.js';
import { log } from '../src/cli/logger.js';

function makeItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'BL-001',
    epic: '4.1 Autenticação',
    type: 'feature',
    title: 'Adicionar login via SSO',
    description: 'Descrição',
    expectedBehavior: 'Comportamento esperado',
    acceptanceCriteria: ['Critério 1'],
    labels: ['label-livre-do-modelo'],
    sprint: 1,
    layer: 'backend',
    requirementIds: ['REQ-001'],
    dependsOn: [],
    priority: 'should',
    ...overrides,
  };
}

function makeMockPublisher(): jest.Mocked<GithubPublisherLike> {
  return {
    listOpenIssuesWithLabel: jest.fn(async () => [{ number: 10, nodeId: 'node-10', title: 'Issue antiga', requirementIds: ['REQ-OLD'] }]),
    listAllOpenIssues: jest.fn(async () => [{ number: 10, nodeId: 'node-10', title: 'Issue antiga', requirementIds: ['REQ-OLD'] }]),
    ensureLabelsExist: jest.fn(async () => undefined),
    deleteIssue: jest.fn(async () => undefined),
    ensureMilestonesExist: jest.fn(async (specs: MilestoneSpec[]) => new Map(specs.map((s) => [s.number, s.number + 100]))),
    createIssue: jest.fn(async () => 99),
    closeCompletedMilestones: jest.fn(async () => []),
  };
}

beforeEach(() => {
  jest.spyOn(log, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('labelsForItem', () => {
  it('gera exatamente uma label por dimensão, no formato "dimensão: valor", mais o marcador do bot', () => {
    const labels = labelsForItem(makeItem({ type: 'bug', layer: 'frontend', priority: 'must' }));

    expect(labels).toEqual(['sdd-bot', 'tipo: bug 🔴', 'layer: frontend', 'priority: must', 'area: autenticacao']);
  });

  it('não inclui sprint-N (é milestone) nem as labels de texto livre do item', () => {
    const labels = labelsForItem(makeItem({ sprint: 3, labels: ['feature', 'auth'] }));

    expect(labels.some((label) => label.startsWith('sprint-'))).toBe(false);
    expect(labels).not.toContain('feature');
    expect(labels).not.toContain('auth');
  });

  it('adiciona status: needs-clarification só quando o item pede decisão técnica', () => {
    const spec = { httpCodes: [], fields: [], limits: null, needsClarification: true, clarificationNote: 'Definir TTL' };

    expect(labelsForItem(makeItem({ technicalSpecificity: spec }))).toContain('status: needs-clarification');
    expect(labelsForItem(makeItem({ technicalSpecificity: { ...spec, needsClarification: false, clarificationNote: null } }))).not.toContain(
      'status: needs-clarification',
    );
    expect(labelsForItem(makeItem())).not.toContain('status: needs-clarification');
  });

  it('as labels de um item são mutuamente exclusivas por dimensão', () => {
    const dimensions = labelsForItem(makeItem()).map((label) => label.split(':')[0]);
    expect(new Set(dimensions).size).toBe(dimensions.length);
  });
});

describe('milestoneSpecs', () => {
  const plan: SprintPlan = {
    sprints: [
      { number: 1, goal: 'Login funcionando de ponta a ponta', requirementIds: ['REQ-1'], startDate: '2026-09-14', dueDate: '2026-09-27' },
      { number: 2, goal: 'Relatórios', requirementIds: ['REQ-2'] },
    ],
  };

  it('preenche objetivo e due date a partir do plano', () => {
    expect(milestoneSpecs([1, 2, 3], plan)).toEqual([
      { number: 1, goal: 'Login funcionando de ponta a ponta', dueDate: '2026-09-27' },
      { number: 2, goal: 'Relatórios', dueDate: undefined },
      { number: 3, goal: undefined, dueDate: undefined },
    ]);
  });

  it('sem plano, só o número', () => {
    expect(milestoneSpecs([2])).toEqual([{ number: 2, goal: undefined, dueDate: undefined }]);
  });
});

describe('publishBacklog', () => {
  it('em modo add + dry-run, não fecha nem cria nada via API de escrita, apenas relata', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem()];

    const result = await publishBacklog(items, publisher, { mode: 'add', dryRun: true });

    expect(publisher.ensureLabelsExist).not.toHaveBeenCalled();
    expect(publisher.deleteIssue).not.toHaveBeenCalled();
    expect(publisher.createIssue).not.toHaveBeenCalled();
    expect(publisher.closeCompletedMilestones).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.created).toEqual([{ title: items[0]!.title, dependsOn: [] }]);
    expect(result.skipped).toEqual([]);
    expect(result.closedMilestones).toEqual([]);
  });

  it('em modo replace + dry-run, lista o que seria apagado sem chamar a API de escrita nem pedir confirmação', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem()];
    const confirmDeleteAll = jest.fn(async () => true);

    const result = await publishBacklog(items, publisher, { mode: 'replace', dryRun: true, confirmDeleteAll });

    expect(publisher.listAllOpenIssues).toHaveBeenCalledTimes(1);
    expect(confirmDeleteAll).not.toHaveBeenCalled();
    expect(publisher.deleteIssue).not.toHaveBeenCalled();
    expect(publisher.ensureLabelsExist).not.toHaveBeenCalled();
    expect(publisher.createIssue).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([{ number: 10, nodeId: 'node-10', title: 'Issue antiga', requirementIds: ['REQ-OLD'] }]);
    expect(result.created).toEqual([{ title: items[0]!.title, dependsOn: [] }]);
  });

  it('em modo add sem dry-run, cria issues com as labels por dimensão e o milestone do sprint', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem({ sprint: 2 })];

    const result = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    const expected = ['sdd-bot', 'tipo: feature 🔵', 'layer: backend', 'priority: should', 'area: autenticacao'];
    expect(publisher.ensureLabelsExist).toHaveBeenCalledWith(expected);
    expect(publisher.createIssue).toHaveBeenCalledWith(items[0], expected, 102, expect.any(Map));
    expect(result.created).toEqual([{ number: 99, title: items[0]!.title, dependsOn: [] }]);
  });

  it('cria/associa um milestone "Sprint N" por sprint distinto, com objetivo e due date do plano', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem({ id: 'BL-001', sprint: 1 }), makeItem({ id: 'BL-002', sprint: 3 })];
    const plan: SprintPlan = {
      sprints: [
        { number: 1, goal: 'Login de ponta a ponta', requirementIds: ['REQ-001'], startDate: '2026-09-14', dueDate: '2026-09-27' },
        { number: 3, goal: 'Relatórios exportáveis', requirementIds: ['REQ-001'], startDate: '2026-10-12', dueDate: '2026-10-25' },
      ],
    };

    await publishBacklog(items, publisher, { mode: 'add', dryRun: false }, plan);

    expect(publisher.ensureMilestonesExist).toHaveBeenCalledWith([
      { number: 1, goal: 'Login de ponta a ponta', dueDate: '2026-09-27' },
      { number: 3, goal: 'Relatórios exportáveis', dueDate: '2026-10-25' },
    ]);
    expect(publisher.createIssue).toHaveBeenNthCalledWith(1, items[0], expect.any(Array), 101, expect.any(Map));
    expect(publisher.createIssue).toHaveBeenNthCalledWith(2, items[1], expect.any(Array), 103, expect.any(Map));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('sem plano de sprints, avisa que os milestones ficam sem objetivo e due date', async () => {
    const publisher = makeMockPublisher();

    await publishBacklog([makeItem()], publisher, { mode: 'add', dryRun: false });

    expect(publisher.ensureMilestonesExist).toHaveBeenCalledWith([{ number: 1, goal: undefined, dueDate: undefined }]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('--sprint-plan'));
  });

  it('não chama ensureMilestonesExist em dry-run', async () => {
    const publisher = makeMockPublisher();

    await publishBacklog([makeItem()], publisher, { mode: 'add', dryRun: true });

    expect(publisher.ensureMilestonesExist).not.toHaveBeenCalled();
  });

  it('fecha milestones concluídos ao final e relata os títulos', async () => {
    const publisher = makeMockPublisher();
    publisher.closeCompletedMilestones.mockResolvedValue(['Sprint 1']);

    const result = await publishBacklog([makeItem({ sprint: 2 })], publisher, { mode: 'replace', dryRun: false });

    expect(publisher.closeCompletedMilestones).toHaveBeenCalledTimes(1);
    expect(result.closedMilestones).toEqual(['Sprint 1']);
  });

  it('em modo replace sem dry-run, apaga issues existentes antes de criar novas', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem()];

    const result = await publishBacklog(items, publisher, { mode: 'replace', dryRun: false });

    expect(publisher.deleteIssue).toHaveBeenCalledWith('node-10');
    expect(result.deleted).toEqual([{ number: 10, nodeId: 'node-10', title: 'Issue antiga', requirementIds: ['REQ-OLD'] }]);
  });

  it('em modo replace, apaga issues sem a label sdd-bot (escopo é o repositório inteiro)', async () => {
    const publisher = makeMockPublisher();
    publisher.listAllOpenIssues.mockResolvedValue([
      { number: 5, nodeId: 'node-5', title: 'Issue manual sem label sdd-bot', requirementIds: [] },
    ]);

    const result = await publishBacklog([makeItem()], publisher, { mode: 'replace', dryRun: false });

    expect(publisher.deleteIssue).toHaveBeenCalledWith('node-5');
    expect(result.deleted).toEqual([{ number: 5, nodeId: 'node-5', title: 'Issue manual sem label sdd-bot', requirementIds: [] }]);
  });

  it('pede confirmação antes de apagar; sem confirmar, cancela a publicação sem apagar nem criar', async () => {
    const publisher = makeMockPublisher();
    const confirmDeleteAll = jest.fn(async () => false);

    await expect(
      publishBacklog([makeItem()], publisher, { mode: 'replace', dryRun: false, confirmDeleteAll }),
    ).rejects.toThrow(/confirmação negada/);

    expect(confirmDeleteAll).toHaveBeenCalledWith(1);
    expect(publisher.deleteIssue).not.toHaveBeenCalled();
    expect(publisher.createIssue).not.toHaveBeenCalled();
  });

  it('confirmando, prossegue normalmente com a deleção', async () => {
    const publisher = makeMockPublisher();
    const confirmDeleteAll = jest.fn(async () => true);

    const result = await publishBacklog([makeItem()], publisher, { mode: 'replace', dryRun: false, confirmDeleteAll });

    expect(confirmDeleteAll).toHaveBeenCalledWith(1);
    expect(publisher.deleteIssue).toHaveBeenCalledWith('node-10');
    expect(result.deleted).toHaveLength(1);
  });

  it('sem issues existentes, não chama o callback de confirmação', async () => {
    const publisher = makeMockPublisher();
    publisher.listAllOpenIssues.mockResolvedValue([]);
    const confirmDeleteAll = jest.fn(async () => true);

    await publishBacklog([makeItem()], publisher, { mode: 'replace', dryRun: false, confirmDeleteAll });

    expect(confirmDeleteAll).not.toHaveBeenCalled();
  });

  it('idempotência: em modo add, não recria uma issue já aberta com o mesmo título', async () => {
    const items = [makeItem({ title: 'Issue já existente' }), makeItem({ id: 'BL-002', title: 'Issue nova' })];
    const publisher = makeMockPublisher();
    publisher.listOpenIssuesWithLabel.mockResolvedValue([{ number: 10, nodeId: 'node-10', title: 'Issue já existente', requirementIds: ['REQ-001'] }]);
    publisher.ensureMilestonesExist.mockResolvedValue(new Map());
    publisher.createIssue.mockResolvedValue(42);

    const result = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(publisher.createIssue).toHaveBeenCalledTimes(1);
    expect(publisher.createIssue).toHaveBeenCalledWith(items[1], expect.any(Array), undefined, expect.any(Map));
    expect(result.skipped).toEqual([{ title: 'Issue já existente', dependsOn: [] }]);
    expect(result.created).toEqual([{ number: 42, title: 'Issue nova', dependsOn: [] }]);
  });

  it('reexecutar publishBacklog em modo add com o mesmo backlog não duplica nenhuma issue', async () => {
    const items = [makeItem({ title: 'Issue estável' })];
    const publishedTitles = new Set<string>();
    const publisher = makeMockPublisher();
    publisher.listOpenIssuesWithLabel.mockImplementation(async () =>
      [...publishedTitles].map((title, index) => ({ number: index + 1, nodeId: `node-${index + 1}`, title, requirementIds: [] })),
    );
    publisher.createIssue.mockImplementation(async (item) => {
      publishedTitles.add(item.title);
      return publishedTitles.size;
    });

    const first = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });
    const second = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual([{ title: 'Issue estável', dependsOn: [] }]);
    expect(publisher.createIssue).toHaveBeenCalledTimes(1);
  });
});

describe('publishBacklog — dependências em ordem topológica', () => {
  const api = makeItem({ id: 'BL-001', title: 'Implementar POST /users com validações', requirementIds: ['REQ-5'], layer: 'backend' });
  const screen = makeItem({ id: 'BL-002', title: 'Implementar tela de cadastro de usuário', requirementIds: ['REQ-9'], layer: 'frontend', dependsOn: ['REQ-5'] });
  const errors = makeItem({ id: 'BL-003', title: 'Exibir erros de validação por campo', requirementIds: ['REQ-10'], layer: 'frontend', dependsOn: ['REQ-9', 'REQ-5'] });

  // O mapa é o mesmo objeto ao longo da publicação: guarda-se uma cópia por chamada.
  const snapshots: Array<Array<[string, number]>> = [];

  function sequentialPublisher(): jest.Mocked<GithubPublisherLike> {
    const publisher = makeMockPublisher();
    publisher.listOpenIssuesWithLabel.mockResolvedValue([]);
    snapshots.length = 0;
    let next = 40;
    publisher.createIssue.mockImplementation(async (_item, _labels, _milestone, map) => {
      snapshots.push([...map.entries()]);
      next += 1;
      return next;
    });
    return publisher;
  }

  it('cria a dependência antes do dependente e passa o mapa com o número já conhecido', async () => {
    const publisher = sequentialPublisher();

    const result = await publishBacklog([errors, screen, api], publisher, { mode: 'add', dryRun: false });

    expect(publisher.createIssue.mock.calls.map(([item]) => item.id)).toEqual(['BL-001', 'BL-002', 'BL-003']);
    expect(snapshots).toEqual([[], [['REQ-5', 41]], [['REQ-5', 41], ['REQ-9', 42]]]);
    expect(result.created).toEqual([
      { number: 41, title: api.title, dependsOn: [] },
      { number: 42, title: screen.title, dependsOn: ['#41'] },
      { number: 43, title: errors.title, dependsOn: ['#42', '#41'] },
    ]);
  });

  it('em modo add, resolve dependência de issue já publicada (outra camada ou execução anterior)', async () => {
    const publisher = sequentialPublisher();
    publisher.listOpenIssuesWithLabel.mockResolvedValue([{ number: 7, nodeId: 'node-7', title: api.title, requirementIds: ['REQ-5'] }]);

    const result = await publishBacklog([screen, api], publisher, { mode: 'add', dryRun: false });

    expect(publisher.createIssue).toHaveBeenCalledTimes(1);
    expect(snapshots).toEqual([[['REQ-5', 7]]]);
    expect(result.created).toEqual([{ number: 41, title: screen.title, dependsOn: ['#7'] }]);
  });

  it('em modo replace, não reaproveita números das issues antigas e marca dependência não publicada', async () => {
    const publisher = sequentialPublisher();
    publisher.listAllOpenIssues.mockResolvedValue([{ number: 7, nodeId: 'node-7', title: api.title, requirementIds: ['REQ-5'] }]);

    const result = await publishBacklog([screen], publisher, { mode: 'replace', dryRun: false });

    expect(publisher.deleteIssue).toHaveBeenCalledWith('node-7');
    expect(result.created).toEqual([{ number: 41, title: screen.title, dependsOn: ['REQ-5 (não publicado)'] }]);
  });

  it('ciclo de dependências aborta antes de qualquer escrita', async () => {
    const publisher = sequentialPublisher();
    const a = makeItem({ id: 'BL-001', title: 'Item A do ciclo', requirementIds: ['REQ-1'], dependsOn: ['REQ-2'] });
    const b = makeItem({ id: 'BL-002', title: 'Item B do ciclo', requirementIds: ['REQ-2'], dependsOn: ['REQ-1'] });

    await expect(publishBacklog([a, b], publisher, { mode: 'replace', dryRun: false })).rejects.toThrow(/ciclo de dependências.*REQ-1 → REQ-2 → REQ-1/);
    expect(publisher.deleteIssue).not.toHaveBeenCalled();
    expect(publisher.createIssue).not.toHaveBeenCalled();
  });

  it('dry-run relata a ordem de criação e as dependências por id de requisito', async () => {
    const publisher = sequentialPublisher();

    const result = await publishBacklog([screen, api], publisher, { mode: 'add', dryRun: true });

    expect(result.created).toEqual([
      { title: api.title, dependsOn: [] },
      { title: screen.title, dependsOn: ['REQ-5'] },
    ]);
  });

  it('itens independentes (mesma camada) são todos criados e o resultado preserva a ordem original', async () => {
    const publisher = sequentialPublisher();
    const first = makeItem({ id: 'BL-010', title: 'Item independente 1', requirementIds: ['REQ-20'] });
    const second = makeItem({ id: 'BL-011', title: 'Item independente 2', requirementIds: ['REQ-21'] });

    const result = await publishBacklog([first, second], publisher, { mode: 'add', dryRun: false });

    expect(publisher.createIssue).toHaveBeenCalledTimes(2);
    expect(publisher.createIssue.mock.calls.map(([item]) => item.id)).toEqual(['BL-010', 'BL-011']);
    expect(result.created.map((created) => created.title)).toEqual([first.title, second.title]);
  });
});
