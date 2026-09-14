import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { SprintPlanSchema } from '../../schemas/sprint-plan.js';
import { parseBacklogFile } from '../../publish/parse-backlog.js';
import { GithubPublisher } from '../../publish/github.js';
import { publishBacklog } from '../../publish/publish-backlog.js';
import { log } from '../logger.js';
import type { BacklogItem } from '../../schemas/backlog-item.js';

interface PublishCommandOptions {
  backlog: string[];
  repo: string;
  mode: 'add' | 'replace';
  dryRun: boolean;
  sprintPlan?: string;
}

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publica itens de backlog (já revisados) como issues em um repositório GitHub')
    .requiredOption(
      '--backlog <paths...>',
      'arquivo(s) de backlog em Markdown; passe as camadas juntas para resolver dependências entre elas',
    )
    .requiredOption('--repo <org/repo>', 'repositório GitHub de destino')
    .option('--mode <add|replace>', 'modo de publicação', 'replace')
    .option('--dry-run', 'exibe o resultado sem chamar a API de escrita', false)
    .option('--sprint-plan <path>', 'sprint-plan.json para preencher objetivo e due date dos milestones')
    .action(async (options: PublishCommandOptions) => {
      if (options.mode !== 'add' && options.mode !== 'replace') {
        throw new Error(`--mode inválido: "${options.mode}". Use "add" ou "replace".`);
      }

      const [owner, repo] = options.repo.split('/');
      if (!owner || !repo) {
        throw new Error(`--repo inválido: "${options.repo}". Use o formato "org/repo".`);
      }

      const items = await readBacklogs(options.backlog);
      const sprintPlan = options.sprintPlan
        ? SprintPlanSchema.parse(JSON.parse(await readFile(options.sprintPlan, 'utf-8')))
        : undefined;

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN não definida. Configure o arquivo .env (ver .env.example).');
      }

      const publisher = new GithubPublisher(token, owner, repo);
      const result = await publishBacklog(
        items,
        publisher,
        { mode: options.mode, dryRun: options.dryRun },
        sprintPlan,
      );

      const prefix = options.dryRun ? '[dry-run] ' : '';
      for (const issue of result.closed) {
        console.log(`${prefix}fechando issue #${issue.number}: ${issue.title}`);
      }
      for (const skipped of result.skipped) {
        console.log(`${prefix}ignorando (já publicada): ${skipped.title}`);
      }
      for (const created of result.created) {
        const label = created.number ? `#${created.number}` : '(nova)';
        const dependsOn = created.dependsOn.length > 0 ? ` (depende de ${created.dependsOn.join(', ')})` : '';
        console.log(`${prefix}criando issue ${label}: ${created.title}${dependsOn}`);
      }
      for (const milestone of result.closedMilestones) {
        console.log(`${prefix}milestone concluído e fechado: ${milestone}`);
      }
      console.log(
        `${prefix}${result.closed.length} issue(ns) fechada(s), ${result.created.length} issue(ns) criada(s), ${result.skipped.length} ignorada(s), ${result.closedMilestones.length} milestone(s) fechado(s)`,
      );
    });
}

/** Concatena os backlogs na ordem informada; um requisito presente em dois arquivos fica com o primeiro. */
async function readBacklogs(paths: string[]): Promise<BacklogItem[]> {
  const items: BacklogItem[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    for (const item of await parseBacklogFile(path)) {
      const duplicate = item.requirementIds.find((id) => seen.has(id));
      if (duplicate) {
        log.warn(`${path}: ${item.id} ("${item.title}") repete ${duplicate}, já presente em ${seen.get(duplicate)}; ignorado.`);
        continue;
      }
      for (const id of item.requirementIds) seen.set(id, path);
      items.push(item);
    }
  }
  return items;
}
