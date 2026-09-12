import { jest } from '@jest/globals';
import type { BacklogItem } from '../src/schemas/backlog-item.js';
import type { GithubPublisherLike } from '../src/publish/publish-backlog.js';
import { publishBacklog } from '../src/publish/publish-backlog.js';

function makeItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'BL-001',
    epic: 'Autenticação',
    type: 'feature',
    title: 'Adicionar login via SSO',
    description: 'Descrição',
    expectedBehavior: 'Comportamento esperado',
    acceptanceCriteria: ['Critério 1'],
    labels: ['feature'],
    sprint: 1,
    layer: 'backend',
    requirementIds: ['REQ-001'],
    priority: 'should',
    ...overrides,
  };
}

function makeMockPublisher(): jest.Mocked<GithubPublisherLike> {
  return {
    listOpenIssuesWithLabel: jest.fn(async () => [{ number: 10, title: 'Issue antiga' }]),
    ensureLabelsExist: jest.fn(async () => undefined),
    closeIssue: jest.fn(async () => undefined),
    ensureMilestonesExist: jest.fn(async (sprints: number[]) => new Map(sprints.map((s) => [s, s + 100]))),
    createIssue: jest.fn(async () => 99),
  };
}

describe('publishBacklog', () => {
  it('em modo add + dry-run, não fecha nem cria nada via API de escrita, apenas relata', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem()];

    const result = await publishBacklog(items, publisher, { mode: 'add', dryRun: true });

    expect(publisher.ensureLabelsExist).not.toHaveBeenCalled();
    expect(publisher.closeIssue).not.toHaveBeenCalled();
    expect(publisher.createIssue).not.toHaveBeenCalled();
    expect(result.closed).toEqual([]);
    expect(result.created).toEqual([{ title: items[0]!.title }]);
    expect(result.skipped).toEqual([]);
  });

  it('em modo replace + dry-run, lista o que seria fechado sem chamar a API de escrita', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem()];

    const result = await publishBacklog(items, publisher, { mode: 'replace', dryRun: true });

    expect(publisher.listOpenIssuesWithLabel).toHaveBeenCalledWith('sdd-bot');
    expect(publisher.closeIssue).not.toHaveBeenCalled();
    expect(publisher.ensureLabelsExist).not.toHaveBeenCalled();
    expect(publisher.createIssue).not.toHaveBeenCalled();
    expect(result.closed).toEqual([{ number: 10, title: 'Issue antiga' }]);
    expect(result.created).toEqual([{ title: items[0]!.title }]);
  });

  it('em modo add sem dry-run, cria issues com as labels esperadas', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem({ labels: ['feature'], sprint: 2 })];

    const result = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(publisher.ensureLabelsExist).toHaveBeenCalledWith(
      expect.arrayContaining(['feature', 'sdd-bot', 'sprint-2', 'priority-should']),
    );
    expect(publisher.createIssue).toHaveBeenCalledWith(
      items[0],
      expect.arrayContaining(['feature', 'sdd-bot', 'sprint-2', 'priority-should']),
      102,
    );
    expect(result.created).toEqual([{ number: 99, title: items[0]!.title }]);
  });

  it('cria/associa um milestone "Sprint N" por sprint distinto entre os itens', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem({ id: 'BL-001', sprint: 1 }), makeItem({ id: 'BL-002', sprint: 3 })];

    await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(publisher.ensureMilestonesExist).toHaveBeenCalledWith([1, 3]);
    expect(publisher.createIssue).toHaveBeenNthCalledWith(1, items[0], expect.any(Array), 101);
    expect(publisher.createIssue).toHaveBeenNthCalledWith(2, items[1], expect.any(Array), 103);
  });

  it('não chama ensureMilestonesExist em dry-run', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem()];

    await publishBacklog(items, publisher, { mode: 'add', dryRun: true });

    expect(publisher.ensureMilestonesExist).not.toHaveBeenCalled();
  });

  it('inclui priority-<priority> como label automática', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem({ priority: 'must' })];

    await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(publisher.ensureLabelsExist).toHaveBeenCalledWith(expect.arrayContaining(['priority-must']));
  });

  it('inclui type, layer e epic (normalizado) como labels automáticas', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem({ epic: 'Autenticação', type: 'feature', layer: 'backend' })];

    await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(publisher.ensureLabelsExist).toHaveBeenCalledWith(
      expect.arrayContaining(['feature', 'backend', 'autenticacao']),
    );
  });

  it('em modo replace sem dry-run, fecha issues existentes antes de criar novas', async () => {
    const publisher = makeMockPublisher();
    const items = [makeItem()];

    const result = await publishBacklog(items, publisher, { mode: 'replace', dryRun: false });

    expect(publisher.closeIssue).toHaveBeenCalledWith(10);
    expect(result.closed).toEqual([{ number: 10, title: 'Issue antiga' }]);
  });

  it('idempotência: em modo add, não recria uma issue já aberta com o mesmo título', async () => {
    const items = [makeItem({ title: 'Issue já existente' }), makeItem({ id: 'BL-002', title: 'Issue nova' })];
    const publisher: jest.Mocked<GithubPublisherLike> = {
      listOpenIssuesWithLabel: jest.fn(async () => [
        { number: 10, title: 'Issue já existente' },
      ]),
      ensureLabelsExist: jest.fn(async () => undefined),
      closeIssue: jest.fn(async () => undefined),
      ensureMilestonesExist: jest.fn(async () => new Map()),
      createIssue: jest.fn(async () => 42),
    };

    const result = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(publisher.createIssue).toHaveBeenCalledTimes(1);
    expect(publisher.createIssue).toHaveBeenCalledWith(items[1], expect.any(Array), undefined);
    expect(result.skipped).toEqual([{ title: 'Issue já existente' }]);
    expect(result.created).toEqual([{ number: 42, title: 'Issue nova' }]);
  });

  it('reexecutar publishBacklog em modo add com o mesmo backlog não duplica nenhuma issue', async () => {
    const items = [makeItem({ title: 'Issue estável' })];
    const publishedTitles = new Set<string>();
    const publisher: jest.Mocked<GithubPublisherLike> = {
      listOpenIssuesWithLabel: jest.fn(async () =>
        [...publishedTitles].map((title, index) => ({ number: index + 1, title })),
      ),
      ensureLabelsExist: jest.fn(async () => undefined),
      closeIssue: jest.fn(async () => undefined),
      ensureMilestonesExist: jest.fn(async () => new Map()),
      createIssue: jest.fn(async (item) => {
        publishedTitles.add(item.title);
        return publishedTitles.size;
      }),
    };

    const first = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });
    const second = await publishBacklog(items, publisher, { mode: 'add', dryRun: false });

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual([{ title: 'Issue estável' }]);
    expect(publisher.createIssue).toHaveBeenCalledTimes(1);
  });
});
