import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { createResilientAIClient } from '../../ai/client-factory.js';
import { extractRequirements } from '../../ingest/extract-requirements.js';
import { parseSddFile } from '../../ingest/parsers.js';

export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Ingest + extração de requisitos a partir de um SDD (.md/.docx/.pdf)')
    .requiredOption('--file <path>', 'caminho do arquivo SDD de entrada')
    .requiredOption('--out <path>', 'caminho do requirements.json de saída')
    .action(async (options: { file: string; out: string }) => {
      const sddText = await parseSddFile(options.file);
      const aiClient = createResilientAIClient();
      const requirements = await extractRequirements(sddText, aiClient);

      await writeFile(options.out, JSON.stringify(requirements, null, 2), 'utf-8');
      console.log(`${requirements.length} requisito(s) extraído(s) → ${options.out}`);
    });
}
