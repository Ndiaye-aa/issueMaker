import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createResilientAIClient } from '../../ai/client-factory.js';
import { buildBacklogForLayer } from '../../backlog/build-backlog.js';
import { extractRequirements } from '../../ingest/extract-requirements.js';
import { parseSddFile } from '../../ingest/parsers.js';
import { buildSprintPlan } from '../../plan/build-sprint-plan.js';
import { renderBacklogMarkdown } from '../../render/backlog-markdown.js';

export function registerProcessCommand(program: Command): void {
  program
    .command('process')
    .description(
      'Executa analyze + plan + backlog em um único passo, a partir de um SDD (.md/.docx/.pdf)',
    )
    .requiredOption('--file <path>', 'caminho do arquivo SDD de entrada')
    .requiredOption('--sprint-length <duration>', 'duração de cada sprint (ex: "2 semanas")')
    .option('--out <dir>', 'diretório de saída para os arquivos de backlog', './out')
    .action(async (options: { file: string; sprintLength: string; out: string }) => {
      const aiClient = createResilientAIClient();

      const sddText = await parseSddFile(options.file);
      const requirements = await extractRequirements(sddText, aiClient);
      console.log(`${requirements.length} requisito(s) extraído(s)`);

      const sprintPlan = await buildSprintPlan(requirements, options.sprintLength, aiClient);
      console.log(`${sprintPlan.sprints.length} sprint(s) planejado(s)`);

      await mkdir(options.out, { recursive: true });

      for (const layer of ['frontend', 'backend'] as const) {
        const items = await buildBacklogForLayer(layer, requirements, sprintPlan, aiClient);
        const markdown = renderBacklogMarkdown(items);
        const outPath = join(options.out, `backlog-${layer}.md`);
        await writeFile(outPath, markdown, 'utf-8');
        console.log(`${items.length} item(ns) de backlog (${layer}) → ${outPath}`);
      }
    });
}
