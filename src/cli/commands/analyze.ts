import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { createAIClient, logUsage } from '../../ai/client-factory.js';
import { extractRequirements } from '../../ingest/extract-requirements.js';
import { parseSddFile } from '../../ingest/parsers.js';

export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Ingest + extração de requisitos a partir de um SDD (.md/.docx/.pdf)')
    .requiredOption('--file <path>', 'caminho do arquivo SDD de entrada')
    .option('--out <path>', 'caminho do requirements.json de saída', './out/requirements.json')
    .option('--no-cache', 'ignora o cache de respostas de IA em disco')
    .action(async (options: { file: string; out: string; cache: boolean }) => {
      const sddText = await parseSddFile(options.file);
      const aiClient = createAIClient({ cache: options.cache });
      try {
        const requirements = await extractRequirements(sddText, aiClient);

        await mkdir(dirname(options.out), { recursive: true });
        await writeFile(options.out, JSON.stringify(requirements, null, 2), 'utf-8');
        console.log(`${requirements.length} requisito(s) extraído(s) → ${options.out}`);
      } finally {
        logUsage(aiClient);
      }
    });
}
