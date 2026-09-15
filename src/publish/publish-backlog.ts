import type { BacklogItem } from '../schemas/backlog-item.js';
import type { SprintPlan } from '../schemas/sprint-plan.js';
import { log } from '../cli/logger.js';
import { renderDependency } from '../render/backlog-markdown.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { sortTopologically } from './dependency-order.js';
import type { GithubIssueRef } from './github.js';
import { BOT_LABEL, formatLabel, NEEDS_CLARIFICATION_STATUS } from './labels.js';

/** Fechar issues/criar labels não tem relação de ordem entre si; limite conservador frente ao secondary rate limit do GitHub REST. */
const GITHUB_INDEPENDENT_CALLS_CONCURRENCY = 5;

export const SDD_BOT_LABEL = BOT_LABEL;

/** Milestone = janela temporal ("quando"); título sempre `Sprint N`. */
export interface MilestoneSpec {
  number: number;
  goal?: string | undefined;
  dueDate?: string | undefined;
}

export interface GithubPublisherLike {
  listOpenIssuesWithLabel(label: string): Promise<GithubIssueRef[]>;
  ensureLabelsExist(labels: string[]): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  ensureMilestonesExist(milestones: MilestoneSpec[]): Promise<Map<number, number>>;
  createIssue(
    item: BacklogItem,
    labels: string[],
    milestoneNumber: number | undefined,
    issueNumberByRequirementId: Map<string, number>,
  ): Promise<number>;
  closeCompletedMilestones(): Promise<string[]>;
}

export interface PublishOptions {
  mode: 'add' | 'replace';
  dryRun: boolean;
}

export interface CreatedIssue {
  number?: number;
  title: string;
  /** Dependências como aparecem no corpo ("#12" ou "REQ-3 (não publicado)"). */
  dependsOn: string[];
}

export interface PublishResult {
  closed: GithubIssueRef[];
  created: CreatedIssue[];
  skipped: CreatedIssue[];
  closedMilestones: string[];
}

/**
 * Uma label por dimensão, todas de dado estruturado (enum/campo calculado). `sprint-N` não
 * entra (é "quando": milestone) nem `item.labels` (texto livre do modelo).
 */
export function labelsForItem(item: BacklogItem): string[] {
  const dimensions: Array<[Parameters<typeof formatLabel>[0], string]> = [
    ['type', item.type],
    ['layer', item.layer],
    ['priority', item.priority],
    ['area', item.epic],
  ];
  if (item.technicalSpecificity?.needsClarification) {
    dimensions.push(['status', NEEDS_CLARIFICATION_STATUS]);
  }
  const labels = dimensions.map(([dimension, value]) => formatLabel(dimension, value));
  return [SDD_BOT_LABEL, ...labels].filter((label) => label.length > 0);
}

export function milestoneSpecs(sprintNumbers: number[], sprintPlan?: SprintPlan): MilestoneSpec[] {
  const byNumber = new Map(sprintPlan?.sprints.map((sprint) => [sprint.number, sprint]) ?? []);
  return sprintNumbers.map((number) => {
    const sprint = byNumber.get(number);
    return { number, goal: sprint?.goal, dueDate: sprint?.dueDate };
  });
}

export async function publishBacklog(
  items: BacklogItem[],
  publisher: GithubPublisherLike,
  options: PublishOptions,
  sprintPlan?: SprintPlan,
): Promise<PublishResult> {
  const result: PublishResult = { closed: [], created: [], skipped: [], closedMilestones: [] };

  // Ordem topológica (ciclo = erro antes de tocar na API): quando um item é criado, as issues
  // das quais depende já existem e o corpo pode citar "#N" numa única passada.
  const orderedItems = sortTopologically(items);

  // Números já conhecidos por id de requisito: no modo "add", todas as issues sdd-bot abertas
  // (inclusive de outras camadas publicadas antes); no "replace", nenhuma — são recriadas.
  const issueNumberByRequirementId = new Map<string, number>();

  // Idempotência do modo "add": issues com o mesmo título já publicadas (label
  // sdd-bot, ainda abertas) não são recriadas em reexecuções.
  let alreadyPublishedTitles = new Set<string>();
  const existing = await publisher.listOpenIssuesWithLabel(SDD_BOT_LABEL);
  if (options.mode === 'replace') {
    if (!options.dryRun) {
      await mapWithConcurrency(existing, GITHUB_INDEPENDENT_CALLS_CONCURRENCY, (issue) =>
        publisher.closeIssue(issue.number),
      );
    }
    result.closed.push(...existing);
  } else {
    alreadyPublishedTitles = new Set(existing.map((issue) => issue.title));
    for (const issue of existing) {
      for (const requirementId of issue.requirementIds) {
        if (!issueNumberByRequirementId.has(requirementId)) {
          issueNumberByRequirementId.set(requirementId, issue.number);
        }
      }
    }
  }

  const itemsToCreate = orderedItems.filter((item) => {
    if (options.mode === 'add' && alreadyPublishedTitles.has(item.title)) {
      result.skipped.push({ title: item.title, dependsOn: item.dependsOn });
      return false;
    }
    return true;
  });

  const allLabels = [...new Set(itemsToCreate.flatMap(labelsForItem))];
  if (!options.dryRun && allLabels.length > 0) {
    await publisher.ensureLabelsExist(allLabels);
  }

  const sprintNumbers = [...new Set(itemsToCreate.map((item) => item.sprint))];
  let milestoneBySprint = new Map<number, number>();
  if (sprintNumbers.length > 0 && !sprintPlan) {
    log.warn('sem --sprint-plan: milestones serão criados só com o título, sem due date nem objetivo.');
  }
  if (!options.dryRun && sprintNumbers.length > 0) {
    milestoneBySprint = await publisher.ensureMilestonesExist(milestoneSpecs(sprintNumbers, sprintPlan));
  }

  for (const item of itemsToCreate) {
    const labels = labelsForItem(item);
    const dependsOn = item.dependsOn.map((id) => renderDependency(id, { issueNumberByRequirementId }));
    if (options.dryRun) {
      result.created.push({ title: item.title, dependsOn: item.dependsOn });
    } else {
      const number = await publisher.createIssue(
        item,
        labels,
        milestoneBySprint.get(item.sprint),
        issueNumberByRequirementId,
      );
      for (const requirementId of item.requirementIds) {
        issueNumberByRequirementId.set(requirementId, number);
      }
      result.created.push({ number, title: item.title, dependsOn });
    }
  }

  if (!options.dryRun) {
    result.closedMilestones = await publisher.closeCompletedMilestones();
  }

  return result;
}
