import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { createAIClient, logUsage } from '../../ai/client-factory.js';
import { buildSprintPlan } from '../../plan/build-sprint-plan.js';
import { RequirementArraySchema } from '../../schemas/requirement.js';
import {
  DEFAULT_BUFFER,
  DEFAULT_MAX_PER_SPRINT,
  DEFAULT_SPRINT_LENGTH,
  parseCapacity,
  parseMaxPerSprint,
  parseStartDate,
} from './options.js';

interface PlanOptions {
  in: string;
  sprintLength: string;
  out: string;
  cache: boolean;
  maxPerSprint: string;
  capacity?: string;
  buffer?: string;
  startDate?: string;
}

export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description('Organiza requisitos extraídos em sprints, respeitando dependências')
    .requiredOption('--in <path>', 'caminho do requirements.json de entrada')
    .option('--sprint-length <duration>', 'duração de cada sprint (ex: "2 semanas")', DEFAULT_SPRINT_LENGTH)
    .option('--out <path>', 'caminho do sprint-plan.json de saída', './out/sprint-plan.json')
    .option('--max-per-sprint <n>', 'teto de requisitos por sprint', String(DEFAULT_MAX_PER_SPRINT))
    .option('--capacity <pontos>', 'capacidade nominal por sprint em pontos de esforço (default: 1 ponto por dia do sprint)')
    .option('--buffer <fração>', `fração da capacidade efetivamente planejada (default ${DEFAULT_BUFFER})`)
    .option('--start-date <YYYY-MM-DD>', 'data de início do sprint 1 (default: hoje)')
    .option('--no-cache', 'ignora o cache de respostas de IA em disco')
    .action(async (options: PlanOptions) => {
      const maxPerSprint = parseMaxPerSprint(options.maxPerSprint);
      const rawRequirements = JSON.parse(await readFile(options.in, 'utf-8'));
      const requirements = RequirementArraySchema.parse(rawRequirements);

      const aiClient = createAIClient({ cache: options.cache });
      try {
        const sprintPlan = await buildSprintPlan(requirements, options.sprintLength, aiClient, {
          maxPerSprint,
          capacity: parseCapacity(options.capacity, options.buffer, options.sprintLength),
          startDate: parseStartDate(options.startDate),
        });

        await mkdir(dirname(options.out), { recursive: true });
        await writeFile(options.out, JSON.stringify(sprintPlan, null, 2), 'utf-8');
        console.log(`${sprintPlan.sprints.length} sprint(s) planejado(s) → ${options.out}`);
      } finally {
        logUsage(aiClient);
      }
    });
}
