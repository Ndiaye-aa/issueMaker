import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
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
      const startedAt = Date.now();
      const result = await publishBacklog(
        items,
        publisher,
        { mode: options.mode, dryRun: options.dryRun, confirmDeleteAll },
        sprintPlan,
      );
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

      const prefix = options.dryRun ? '[dry-run] ' : '';
      for (const issue of result.deleted) {
        console.log(`${prefix}apagando permanentemente issue #${issue.number}: ${issue.title}`);
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
        `${prefix}${result.deleted.length} issue(ns) apagada(s) permanentemente, ${result.created.length} issue(ns) criada(s), ${result.skipped.length} ignorada(s), ${result.closedMilestones.length} milestone(s) fechado(s) em ${elapsedSeconds}s`,
      );
    });
}

/** Modo replace: pede confirmação explícita antes de apagar issues existentes (ação irreversível). */
async function confirmDeleteAll(count: number): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `[sdd-bot] modo replace vai apagar PERMANENTEMENTE ${count} issue(ns) aberta(s) no repositório ` +
        `(todas, não só as do sdd-bot). Essa ação não pode ser desfeita. Continuar? (y/N) `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
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
