import { Octokit } from 'octokit';
import type { BacklogItem } from '../schemas/backlog-item.js';
import { parseRequirementIdsFromBody, renderBacklogItemMarkdown } from '../render/backlog-markdown.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { getLabelColor } from './labels.js';
import type { MilestoneSpec } from './publish-backlog.js';

/** Criar/atualizar labels não tem relação de ordem entre si; limite conservador frente ao secondary rate limit do GitHub REST. */
const INDEPENDENT_CALLS_CONCURRENCY = 5;

export interface GithubIssueRef {
  number: number;
  title: string;
  /** Ids de requisito lidos do comentário sdd-bot:meta no corpo (resolvem "Depende de: #N"). */
  requirementIds: string[];
}

const MILESTONE_TITLE_REGEX = /^Sprint (\d+)$/;

export function milestoneTitle(sprint: number): string {
  return `Sprint ${sprint}`;
}

/** GitHub guarda due_on como timestamp; a data alvo entra à meia-noite UTC. */
export function milestoneDueOn(dueDate: string): string {
  return `${dueDate}T00:00:00Z`;
}

export class GithubPublisher {
  private readonly octokit: Octokit;

  constructor(
    token: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    this.octokit = new Octokit({ auth: token });
  }

  async listOpenIssuesWithLabel(label: string): Promise<GithubIssueRef[]> {
    // paginate: repositórios com mais de 100 issues do bot não devem duplicar em modo add.
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: 100,
    });
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        requirementIds: parseRequirementIdsFromBody(issue.body),
      }));
  }

  /** Cria as labels ausentes e alinha a cor das existentes à paleta por dimensão. */
  async ensureLabelsExist(labels: string[]): Promise<void> {
    const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
      owner: this.owner,
      repo: this.repo,
      per_page: 100,
    });
    const colorByName = new Map(existing.map((label) => [label.name, label.color.toUpperCase()]));

    await mapWithConcurrency(labels, INDEPENDENT_CALLS_CONCURRENCY, async (label) => {
      const color = getLabelColor(label);
      const current = colorByName.get(label);
      if (current === undefined) {
        await this.octokit.rest.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
          color,
        });
      } else if (current !== color) {
        await this.octokit.rest.issues.updateLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
          color,
        });
      }
    });
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: 'closed',
    });
  }

  /**
   * Um milestone `Sprint N` por sprint: reaproveita (e reabre) os já existentes, inclusive
   * fechados — recriar um título existente dá 422 — e mantém descrição (= objetivo do
   * sprint) e due date alinhados ao plano.
   */
  async ensureMilestonesExist(milestones: MilestoneSpec[]): Promise<Map<number, number>> {
    const existing = await this.octokit.paginate(this.octokit.rest.issues.listMilestones, {
      owner: this.owner,
      repo: this.repo,
      state: 'all',
      per_page: 100,
    });

    const bySprint = new Map<number, number>();
    const existingBySprint = new Map<number, (typeof existing)[number]>();
    for (const milestone of existing) {
      const match = MILESTONE_TITLE_REGEX.exec(milestone.title);
      if (match?.[1]) {
        existingBySprint.set(Number(match[1]), milestone);
        bySprint.set(Number(match[1]), milestone.number);
      }
    }

    for (const spec of milestones) {
      const current = existingBySprint.get(spec.number);
      const description = spec.goal ?? undefined;
      const dueOn = spec.dueDate ? milestoneDueOn(spec.dueDate) : undefined;

      if (!current) {
        const created = await this.octokit.rest.issues.createMilestone({
          owner: this.owner,
          repo: this.repo,
          title: milestoneTitle(spec.number),
          ...(description !== undefined ? { description } : {}),
          ...(dueOn !== undefined ? { due_on: dueOn } : {}),
        });
        bySprint.set(spec.number, created.data.number);
        continue;
      }

      const currentDue = current.due_on ? current.due_on.slice(0, 10) : undefined;
      const needsReopen = current.state === 'closed';
      const needsDescription = description !== undefined && (current.description ?? '') !== description;
      const needsDueDate = spec.dueDate !== undefined && currentDue !== spec.dueDate;
      if (needsReopen || needsDescription || needsDueDate) {
        await this.octokit.rest.issues.updateMilestone({
          owner: this.owner,
          repo: this.repo,
          milestone_number: current.number,
          ...(needsReopen ? { state: 'open' } : {}),
          ...(needsDescription ? { description } : {}),
          ...(needsDueDate && dueOn !== undefined ? { due_on: dueOn } : {}),
        });
      }
    }

    return bySprint;
  }

  /**
   * Sprint genuinamente encerrada = milestone fechado: fecha os `Sprint N` abertos cujas
   * issues estão todas fechadas. Devolve os títulos fechados.
   */
  async closeCompletedMilestones(): Promise<string[]> {
    const open = await this.octokit.paginate(this.octokit.rest.issues.listMilestones, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      per_page: 100,
    });
    const closed: string[] = [];
    for (const milestone of open) {
      if (!MILESTONE_TITLE_REGEX.test(milestone.title)) continue;
      if (milestone.open_issues === 0 && milestone.closed_issues > 0) {
        await this.octokit.rest.issues.updateMilestone({
          owner: this.owner,
          repo: this.repo,
          milestone_number: milestone.number,
          state: 'closed',
        });
        closed.push(milestone.title);
      }
    }
    return closed;
  }

  async createIssue(
    item: BacklogItem,
    labels: string[],
    milestoneNumber: number | undefined,
    issueNumberByRequirementId: Map<string, number>,
  ): Promise<number> {
    const response = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: item.title,
      body: renderBacklogItemMarkdown(item, { issueNumberByRequirementId }),
      labels,
      ...(milestoneNumber !== undefined ? { milestone: milestoneNumber } : {}),
    });
    return response.data.number;
  }
}
