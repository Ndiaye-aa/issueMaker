import type { Command } from 'commander';
import { parseBacklogFile } from '../../publish/parse-backlog.js';
import { GithubPublisher } from '../../publish/github.js';
import { publishBacklog } from '../../publish/publish-backlog.js';

interface PublishCommandOptions {
  backlog: string;
  repo: string;
  mode: 'add' | 'replace';
  dryRun: boolean;
}

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publica itens de backlog (já revisados) como issues em um repositório GitHub')
    .requiredOption('--backlog <path>', 'caminho do arquivo de backlog em Markdown')
    .requiredOption('--repo <org/repo>', 'repositório GitHub de destino')
    .option('--mode <add|replace>', 'modo de publicação', 'add')
    .option('--dry-run', 'exibe o resultado sem chamar a API de escrita', false)
    .action(async (options: PublishCommandOptions) => {
      if (options.mode !== 'add' && options.mode !== 'replace') {
        throw new Error(`--mode inválido: "${options.mode}". Use "add" ou "replace".`);
      }

      const [owner, repo] = options.repo.split('/');
      if (!owner || !repo) {
        throw new Error(`--repo inválido: "${options.repo}". Use o formato "org/repo".`);
      }

      const items = await parseBacklogFile(options.backlog);

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN não definida. Configure o arquivo .env (ver .env.example).');
      }

      const publisher = new GithubPublisher(token, owner, repo);
      const result = await publishBacklog(items, publisher, {
        mode: options.mode,
        dryRun: options.dryRun,
      });

      const prefix = options.dryRun ? '[dry-run] ' : '';
      for (const issue of result.closed) {
        console.log(`${prefix}fechando issue #${issue.number}: ${issue.title}`);
      }
      for (const skipped of result.skipped) {
        console.log(`${prefix}ignorando (já publicada): ${skipped.title}`);
      }
      for (const created of result.created) {
        const label = created.number ? `#${created.number}` : '(nova)';
        console.log(`${prefix}criando issue ${label}: ${created.title}`);
      }
      console.log(
        `${prefix}${result.closed.length} issue(ns) fechada(s), ${result.created.length} issue(ns) criada(s), ${result.skipped.length} ignorada(s)`,
      );
    });
}
