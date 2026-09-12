import type { BacklogItem } from '../schemas/backlog-item.js';
import type { GithubIssueRef } from './github.js';

export const SDD_BOT_LABEL = 'sdd-bot';

export interface GithubPublisherLike {
  listOpenIssuesWithLabel(label: string): Promise<GithubIssueRef[]>;
  ensureLabelsExist(labels: string[]): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  createIssue(item: BacklogItem, labels: string[]): Promise<number>;
}

export interface PublishOptions {
  mode: 'add' | 'replace';
  dryRun: boolean;
}

export interface CreatedIssue {
  number?: number;
  title: string;
}

export interface PublishResult {
  closed: GithubIssueRef[];
  created: CreatedIssue[];
  skipped: CreatedIssue[];
}

export function labelsForItem(item: BacklogItem): string[] {
  return [...new Set([...item.labels, SDD_BOT_LABEL, `sprint-${item.sprint}`])];
}

export async function publishBacklog(
  items: BacklogItem[],
  publisher: GithubPublisherLike,
  options: PublishOptions,
): Promise<PublishResult> {
  const result: PublishResult = { closed: [], created: [], skipped: [] };

  // Idempotência do modo "add": issues com o mesmo título já publicadas (label
  // sdd-bot, ainda abertas) não são recriadas em reexecuções.
  let alreadyPublishedTitles = new Set<string>();
  if (options.mode === 'replace') {
    const existing = await publisher.listOpenIssuesWithLabel(SDD_BOT_LABEL);
    for (const issue of existing) {
      if (!options.dryRun) {
        await publisher.closeIssue(issue.number);
      }
      result.closed.push(issue);
    }
  } else {
    const existing = await publisher.listOpenIssuesWithLabel(SDD_BOT_LABEL);
    alreadyPublishedTitles = new Set(existing.map((issue) => issue.title));
  }

  const itemsToCreate = items.filter((item) => {
    if (options.mode === 'add' && alreadyPublishedTitles.has(item.title)) {
      result.skipped.push({ title: item.title });
      return false;
    }
    return true;
  });

  const allLabels = [...new Set(itemsToCreate.flatMap(labelsForItem))];
  if (!options.dryRun && allLabels.length > 0) {
    await publisher.ensureLabelsExist(allLabels);
  }

  for (const item of itemsToCreate) {
    const labels = labelsForItem(item);
    if (options.dryRun) {
      result.created.push({ title: item.title });
    } else {
      const number = await publisher.createIssue(item, labels);
      result.created.push({ number, title: item.title });
    }
  }

  return result;
}
