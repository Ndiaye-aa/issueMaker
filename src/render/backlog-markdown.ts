import type { BacklogItem } from '../schemas/backlog-item.js';
import { BacklogItemSchema } from '../schemas/backlog-item.js';

/**
 * Metadados que não aparecem no template visível de issue (Seção 6 do SDD), mas são
 * necessários para reconstruir o BacklogItem fielmente ao fazer o parse de volta
 * (round-trip), usados pelo comando `publish` (Sprint 5).
 */
function renderMetaComment(item: BacklogItem): string {
  return `<!-- sdd-bot:meta id="${item.id}" epic="${escapeAttr(item.epic)}" layer="${item.layer}" requirementIds="${item.requirementIds.join(',')}" -->`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

export function renderBacklogItemMarkdown(item: BacklogItem): string {
  const lines: string[] = [];
  lines.push(`### [Sprint ${item.sprint}] ${item.title}`);
  lines.push(renderMetaComment(item));
  lines.push(`**Tipo:** ${item.type}`);
  lines.push(`**Prioridade:** ${item.priority}`);
  lines.push(`**Labels:** ${item.labels.map((label) => `\`${label}\``).join(', ')}`);
  lines.push('');
  lines.push('**Descrição:**');
  lines.push(item.description);
  lines.push('');

  if (item.type === 'bug' && item.reproSteps && item.reproSteps.length > 0) {
    lines.push('**Passos para reproduzir:**');
    item.reproSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push('');
  }

  lines.push('**Comportamento esperado:**');
  lines.push(item.expectedBehavior);
  lines.push('');

  if (item.environment) {
    lines.push(`**Ambiente:** ${item.environment}`);
    lines.push('');
  }

  lines.push('**Critérios de aceite:**');
  item.acceptanceCriteria.forEach((criterion) => lines.push(`- [ ] ${criterion}`));
  lines.push('');

  if (item.requirementIds.length > 0) {
    lines.push(`**Rastreabilidade:** ${item.requirementIds.join(', ')} (ver requirements.json)`);
    lines.push('');
  }

  lines.push('---');

  return lines.join('\n');
}

export function renderBacklogMarkdown(items: BacklogItem[]): string {
  return items.map(renderBacklogItemMarkdown).join('\n\n');
}

const ITEM_SPLIT_REGEX = /(?=^### \[Sprint \d+\])/m;
const HEADING_REGEX = /^### \[Sprint (\d+)\] (.+)$/m;
const META_REGEX =
  /<!--\s*sdd-bot:meta\s+id="([^"]*)"\s+epic="([^"]*)"\s+layer="([^"]*)"\s+requirementIds="([^"]*)"\s*-->/;
const TYPE_REGEX = /^\*\*Tipo:\*\*\s*(feature|bug|tech-debt)\s*$/m;
const PRIORITY_REGEX = /^\*\*Prioridade:\*\*\s*(must|should|could)\s*$/m;
const LABELS_REGEX = /^\*\*Labels:\*\*\s*(.*)$/m;
const DESCRIPTION_REGEX = /\*\*Descrição:\*\*\n([\s\S]*?)\n\n/;
const REPRO_STEPS_REGEX = /\*\*Passos para reproduzir:\*\*\n([\s\S]*?)\n\n/;
const EXPECTED_BEHAVIOR_REGEX = /\*\*Comportamento esperado:\*\*\n([\s\S]*?)\n\n/;
const ENVIRONMENT_REGEX = /^\*\*Ambiente:\*\*\s*(.*)$/m;
const ACCEPTANCE_REGEX = /\*\*Critérios de aceite:\*\*\n([\s\S]*?)(?:\n\n|\n---|$)/;

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"');
}

export function parseBacklogMarkdown(markdown: string): BacklogItem[] {
  const blocks = markdown
    .split(ITEM_SPLIT_REGEX)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return blocks.map((block) => parseBacklogItemBlock(block));
}

function parseBacklogItemBlock(block: string): BacklogItem {
  const headingMatch = block.match(HEADING_REGEX);
  if (!headingMatch) {
    throw new Error(`Bloco de backlog sem heading reconhecível: ${block.slice(0, 80)}...`);
  }
  const sprint = Number(headingMatch[1]);
  const title = headingMatch[2]?.trim() ?? '';

  const metaMatch = block.match(META_REGEX);
  if (!metaMatch) {
    throw new Error(`Bloco de backlog "${title}" sem metadados sdd-bot:meta`);
  }
  const [, id, epicRaw, layerRaw, requirementIdsRaw] = metaMatch;
  const epic = unescapeAttr(epicRaw ?? '');
  const layer = layerRaw as BacklogItem['layer'];
  const requirementIds = (requirementIdsRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const typeMatch = block.match(TYPE_REGEX);
  const type = (typeMatch?.[1] ?? 'feature') as BacklogItem['type'];

  const priorityMatch = block.match(PRIORITY_REGEX);
  const priority = (priorityMatch?.[1] ?? 'should') as BacklogItem['priority'];

  const labelsMatch = block.match(LABELS_REGEX);
  const labels = (labelsMatch?.[1] ?? '')
    .split(',')
    .map((label) => label.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);

  const description = DESCRIPTION_REGEX.exec(block)?.[1]?.trim() ?? '';
  const expectedBehavior = EXPECTED_BEHAVIOR_REGEX.exec(block)?.[1]?.trim() ?? '';

  const reproStepsMatch = REPRO_STEPS_REGEX.exec(block);
  const reproSteps = reproStepsMatch
    ? parseNumberedList(reproStepsMatch[1] ?? '')
    : undefined;

  const environmentMatch = block.match(ENVIRONMENT_REGEX);
  const environment = environmentMatch?.[1]?.trim() || undefined;

  const acceptanceMatch = ACCEPTANCE_REGEX.exec(block);
  const acceptanceCriteria = parseCheckboxList(acceptanceMatch?.[1] ?? '');

  const item = {
    id: id ?? '',
    epic,
    type,
    priority,
    title,
    description,
    expectedBehavior,
    reproSteps,
    environment,
    acceptanceCriteria,
    labels,
    sprint,
    layer,
    requirementIds,
  };

  return BacklogItemSchema.parse(item);
}

function parseNumberedList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\.\s*/, '').trim())
    .filter(Boolean);
}

function parseCheckboxList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*\[.\]\s*/, '').trim())
    .filter(Boolean);
}
