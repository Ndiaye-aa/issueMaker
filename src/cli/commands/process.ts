import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createAIClient, logUsage, readBacklogBatchSize } from '../../ai/client-factory.js';
import { buildBacklogForLayer } from '../../backlog/build-backlog.js';
import { extractRequirements } from '../../ingest/extract-requirements.js';
import { parseSddFile } from '../../ingest/parsers.js';
import { buildSprintPlan } from '../../plan/build-sprint-plan.js';
import { renderBacklogMarkdown } from '../../render/backlog-markdown.js';
import { log } from '../logger.js';
import {
  DEFAULT_BUFFER,
  DEFAULT_MAX_PER_SPRINT,
  DEFAULT_SPRINT_LENGTH,
  parseCapacity,
  parseMaxPerSprint,
  parseStartDate,
} from './options.js';

interface ProcessOptions {
  file: string;
  sprintLength: string;
  out: string;
  cache: boolean;
  maxPerSprint: string;
  capacity?: string;
  buffer?: string;
  startDate?: string;
}

export function registerProcessCommand(program: Command): void {
  program
    .command('process')
    .description(
      'Executa analyze + plan + backlog em um único passo, a partir de um SDD (.md/.docx/.pdf)',
    )
    .requiredOption('--file <path>', 'caminho do arquivo SDD de entrada')
    .option('--sprint-length <duration>', 'duração de cada sprint (ex: "2 semanas")', DEFAULT_SPRINT_LENGTH)
    .option('--out <dir>', 'diretório de saída para os arquivos gerados', './out')
    .option('--max-per-sprint <n>', 'teto de requisitos por sprint', String(DEFAULT_MAX_PER_SPRINT))
    .option('--capacity <pontos>', 'capacidade nominal por sprint em pontos de esforço (default: 1 ponto por dia do sprint)')
    .option('--buffer <fração>', `fração da capacidade efetivamente planejada (default ${DEFAULT_BUFFER})`)
    .option('--start-date <YYYY-MM-DD>', 'data de início do sprint 1 (default: hoje)')
    .option('--no-cache', 'ignora o cache de respostas de IA em disco')
    .action(async (options: ProcessOptions) => {
      const maxPerSprint = parseMaxPerSprint(options.maxPerSprint);
      const aiClient = createAIClient({ cache: options.cache });
      const batchSize = readBacklogBatchSize();
      await mkdir(options.out, { recursive: true });

      try {
        log.step(`etapa 1/3: análise de ${options.file}`);
        const sddText = await parseSddFile(options.file);
        const requirements = await extractRequirements(sddText, aiClient);
        const requirementsPath = join(options.out, 'requirements.json');
        await writeFile(requirementsPath, JSON.stringify(requirements, null, 2), 'utf-8');
        console.log(`${requirements.length} requisito(s) extraído(s) → ${requirementsPath}`);

        log.step('etapa 2/3: planejamento de sprints');
        const sprintPlan = await buildSprintPlan(requirements, options.sprintLength, aiClient, {
          maxPerSprint,
          capacity: parseCapacity(options.capacity, options.buffer, options.sprintLength),
          startDate: parseStartDate(options.startDate),
        });
        const planPath = join(options.out, 'sprint-plan.json');
        await writeFile(planPath, JSON.stringify(sprintPlan, null, 2), 'utf-8');
        console.log(`${sprintPlan.sprints.length} sprint(s) planejado(s) → ${planPath}`);

        for (const layer of ['frontend', 'backend'] as const) {
          log.step(`etapa 3/3: backlog ${layer}`);
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
