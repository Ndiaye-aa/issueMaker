import { readFile } from 'node:fs/promises';
import type { BacklogItem } from '../schemas/backlog-item.js';
import { parseBacklogMarkdown } from '../render/backlog-markdown.js';

export async function parseBacklogFile(path: string): Promise<BacklogItem[]> {
  const markdown = await readFile(path, 'utf-8');
  return parseBacklogMarkdown(markdown);
}
