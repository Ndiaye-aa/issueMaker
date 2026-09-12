import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createResilientAIClient } from './src/ai/client-factory.ts';
import { buildBacklogForLayer } from './src/backlog/build-backlog.ts';
import { parseSddFile } from './src/ingest/parsers.ts';
import { chunkDocument } from './src/ingest/chunker.ts';
import { buildExtractRequest } from './src/ai/prompts/extract.ts';
import { RequirementArraySchema, type Requirement } from './src/schemas/requirement.ts';
import { findSimilarPairs } from './src/ingest/dedupe.ts';
import { buildDedupeConfirmRequest, DedupeConfirmSchema } from './src/ai/prompts/dedupe-confirm.ts';
import { buildSprintPlan } from './src/plan/build-sprint-plan.ts';
import { renderBacklogMarkdown } from './src/render/backlog-markdown.ts';

async function main() {
  const aiClient = createResilientAIClient();
  const sddText = await parseSddFile('./in/sddAtlus.pdf');
  const chunks = chunkDocument(sddText);
  console.log('chunks:', chunks.length);

  const merged: Requirement[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const start = Date.now();
    const existingIds = merged.map((r) => r.id);
    const request = buildExtractRequest(chunks[i], existingIds);
    const extracted = await aiClient.complete(request, RequirementArraySchema);
    merged.push(...extracted);
    console.log(`chunk ${i + 1}/${chunks.length} ms=${Date.now() - start} extracted=${extracted.length} total=${merged.length}`);
  }

  console.log('dedupe: finding similar pairs...');
  const pairs = findSimilarPairs(merged, (r) => r.title, 0.6);
  console.log('pairs to confirm:', pairs.length);
  const idsToRemove = new Set<string>();
  for (const pair of pairs) {
    if (idsToRemove.has(pair.a.id) || idsToRemove.has(pair.b.id)) continue;
    const start = Date.now();
    const req = buildDedupeConfirmRequest(pair.a, pair.b);
    const confirmation = await aiClient.complete(req, DedupeConfirmSchema);
    console.log(`dedupe pair ms=${Date.now() - start} same=${confirmation.same}`);
    if (confirmation.same) idsToRemove.add(pair.b.id);
  }
  const requirements = merged.filter((r) => !idsToRemove.has(r.id));
  console.log(`${requirements.length} requisito(s) extraído(s) (pós-dedupe)`);

  const sprintPlan = await buildSprintPlan(requirements, '2 semanas', aiClient);
  console.log(`${sprintPlan.sprints.length} sprint(s) planejado(s)`);

  await mkdir('./out', { recursive: true });
  for (const layer of ['frontend', 'backend'] as const) {
    const items = await buildBacklogForLayer(layer, requirements, sprintPlan, aiClient);
    const markdown = renderBacklogMarkdown(items);
    const outPath = join('./out', `backlog-${layer}.md`);
    await writeFile(outPath, markdown, 'utf-8');
    console.log(`${items.length} item(ns) de backlog (${layer}) -> ${outPath}`);
  }
  console.log('DONE');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
