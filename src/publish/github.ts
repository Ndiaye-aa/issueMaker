import { Octokit } from 'octokit';
import type { BacklogItem } from '../schemas/backlog-item.js';
import { renderBacklogItemMarkdown } from '../render/backlog-markdown.js';

export interface GithubIssueRef {
  number: number;
  title: string;
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
    const issues = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: 100,
    });
    return issues.data.map((issue) => ({ number: issue.number, title: issue.title }));
  }

  async ensureLabelsExist(labels: string[]): Promise<void> {
    const existing = await this.octokit.rest.issues.listLabelsForRepo({
      owner: this.owner,
      repo: this.repo,
      per_page: 100,
    });
    const existingNames = new Set(existing.data.map((label) => label.name));

    for (const label of labels) {
      if (!existingNames.has(label)) {
        await this.octokit.rest.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
        });
      }
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: 'closed',
    });
  }

  async createIssue(item: BacklogItem, labels: string[]): Promise<number> {
    const response = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: item.title,
      body: renderBacklogItemMarkdown(item),
      labels,
    });
    return response.data.number;
  }
}
