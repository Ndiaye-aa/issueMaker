import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { createResilientAIClient } from '../../ai/client-factory.js';
import { buildSprintPlan } from '../../plan/build-sprint-plan.js';
import { RequirementArraySchema } from '../../schemas/requirement.js';

export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description('Organiza requisitos extraídos em sprints, respeitando dependências')
    .requiredOption('--in <path>', 'caminho do requirements.json de entrada')
    .requiredOption('--sprint-length <duration>', 'duração de cada sprint (ex: "2 semanas")')
    .option('--out <path>', 'caminho do sprint-plan.json de saída', './out/sprint-plan.json')
    .action(async (options: { in: string; sprintLength: string; out: string }) => {
      const rawRequirements = JSON.parse(await readFile(options.in, 'utf-8'));
      const requirements = RequirementArraySchema.parse(rawRequirements);

      const aiClient = createResilientAIClient();
      const sprintPlan = await buildSprintPlan(requirements, options.sprintLength, aiClient);

      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, JSON.stringify(sprintPlan, null, 2), 'utf-8');
      console.log(`${sprintPlan.sprints.length} sprint(s) planejado(s) → ${options.out}`);
    });
}
