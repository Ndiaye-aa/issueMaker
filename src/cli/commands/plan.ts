import { readFile, writeFile } from 'node:fs/promises';
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
    .requiredOption('--out <path>', 'caminho do sprint-plan.json de saída')
    .action(async (options: { in: string; sprintLength: string; out: string }) => {
      const rawRequirements = JSON.parse(await readFile(options.in, 'utf-8'));
      const requirements = RequirementArraySchema.parse(rawRequirements);

      const aiClient = createResilientAIClient();
      const sprintPlan = await buildSprintPlan(requirements, options.sprintLength, aiClient);

      await writeFile(options.out, JSON.stringify(sprintPlan, null, 2), 'utf-8');
      console.log(`${sprintPlan.sprints.length} sprint(s) planejado(s) → ${options.out}`);
    });
}
