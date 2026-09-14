import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createAIClient, logUsage, readBacklogBatchSize } from '../../ai/client-factory.js';
import { buildBacklogForLayer } from '../../backlog/build-backlog.js';
import { renderBacklogMarkdown } from '../../render/backlog-markdown.js';
import { RequirementArraySchema } from '../../schemas/requirement.js';
import { SprintPlanSchema } from '../../schemas/sprint-plan.js';

export function registerBacklogCommand(program: Command): void {
  program
    .command('backlog')
    .description(
      'Gera backlog em Markdown (frontend/backend) a partir de requisitos + plano de sprints',
    )
    .requiredOption('--in <path>', 'caminho do requirements.json de entrada')
    .requiredOption('--plan <path>', 'caminho do sprint-plan.json de entrada')
    .option('--out <dir>', 'diretório de saída para os arquivos de backlog', './out')
    .option('--no-cache', 'ignora o cache de respostas de IA em disco')
    .action(async (options: { in: string; plan: string; out: string; cache: boolean }) => {
      const requirements = RequirementArraySchema.parse(
        JSON.parse(await readFile(options.in, 'utf-8')),
      );
      const sprintPlan = SprintPlanSchema.parse(JSON.parse(await readFile(options.plan, 'utf-8')));

      const aiClient = createAIClient({ cache: options.cache });
      const batchSize = readBacklogBatchSize();
      await mkdir(options.out, { recursive: true });

      try {
        for (const layer of ['frontend', 'backend'] as const) {
          const items = await buildBacklogForLayer(layer, requirements, sprintPlan, aiClient, { batchSize });
          const markdown = renderBacklogMarkdown(items);
          const outPath = join(options.out, `backlog-${layer}.md`);
          await writeFile(outPath, markdown, 'utf-8');
          console.log(`${items.length} item(ns) de backlog (${layer}) → ${outPath}`);
        }
      } finally {
        logUsage(aiClient);
      }
    });
}
