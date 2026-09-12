import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createResilientAIClient } from '../../ai/client-factory.js';
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
    .requiredOption('--out <dir>', 'diretório de saída para os arquivos de backlog')
    .action(async (options: { in: string; plan: string; out: string }) => {
      const requirements = RequirementArraySchema.parse(
        JSON.parse(await readFile(options.in, 'utf-8')),
      );
      const sprintPlan = SprintPlanSchema.parse(JSON.parse(await readFile(options.plan, 'utf-8')));

      const aiClient = createResilientAIClient();

      for (const layer of ['frontend', 'backend'] as const) {
        const items = await buildBacklogForLayer(layer, requirements, sprintPlan, aiClient);
        const markdown = renderBacklogMarkdown(items);
        const outPath = join(options.out, `backlog-${layer}.md`);
        await writeFile(outPath, markdown, 'utf-8');
        console.log(`${items.length} item(ns) de backlog (${layer}) → ${outPath}`);
      }
    });
}
