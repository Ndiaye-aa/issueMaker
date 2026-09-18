import type { BacklogItem, TechnicalSpecificity } from '../schemas/backlog-item.js';
import { BacklogItemSchema } from '../schemas/backlog-item.js';

/**
 * Metadados que não aparecem no template visível de issue (Seção 6 do SDD), mas são
 * necessários para reconstruir o BacklogItem fielmente ao fazer o parse de volta
 * (round-trip), usados pelo comando `publish` (Sprint 5).
 */
function renderMetaComment(item: BacklogItem): string {
  return `<!-- sdd-bot:meta id="${item.id}" epic="${escapeAttr(item.epic)}" layer="${item.layer}" requirementIds="${item.requirementIds.join(',')}" dependsOn="${item.dependsOn.join(',')}" -->`;
}

export interface RenderOptions {
  /**
   * Números de issue já publicadas, por id de requisito. Com o mapa, "Depende de" vira `#N`
   * (o GitHub linka sozinho); sem ele (arquivo backlog.md), fica o id do requisito.
   */
  issueNumberByRequirementId?: Map<string, number> | undefined;
}

export const UNPUBLISHED_DEPENDENCY_SUFFIX = '(não publicado)';

export function renderDependency(requirementId: string, options: RenderOptions): string {
  const map = options.issueNumberByRequirementId;
  if (!map) return requirementId;
  const number = map.get(requirementId);
  return number === undefined ? `${requirementId} ${UNPUBLISHED_DEPENDENCY_SUFFIX}` : `#${number}`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

const CLARIFICATION_YES = 'sim';
const CLARIFICATION_NO = 'não';

function renderTechnicalSpecificity(spec: TechnicalSpecificity): string[] {
  const lines: string[] = ['**Especificidade técnica:**'];
  if (spec.httpCodes.length > 0) lines.push(`- Códigos HTTP: ${spec.httpCodes.join(', ')}`);
  if (spec.fields.length > 0) lines.push(`- Campos: ${spec.fields.map((field) => `\`${field}\``).join(', ')}`);
  if (spec.limits) lines.push(`- Limites: ${spec.limits}`);
  const clarification = spec.needsClarification
    ? `${CLARIFICATION_YES} — ${spec.clarificationNote ?? ''}`.trimEnd()
    : CLARIFICATION_NO;
  lines.push(`- Precisa de esclarecimento: ${clarification}`);
  return lines;
}

export function renderBacklogItemMarkdown(item: BacklogItem, options: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`### [Sprint ${item.sprint}] ${item.title}`);
  lines.push(renderMetaComment(item));
  lines.push(`**Tipo:** ${item.type}`);
  lines.push(`**Prioridade:** ${item.priority}`);
  if (item.dependsOn.length > 0) {
    lines.push(`**Depende de:** ${item.dependsOn.map((id) => renderDependency(id, options)).join(', ')}`);
  }
  if (item.labels.length > 0) {
    lines.push(`**Labels:** ${item.labels.map((label) => `\`${label}\``).join(', ')}`);
  }
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

  if (item.technicalSpecificity) {
    lines.push(...renderTechnicalSpecificity(item.technicalSpecificity));
    lines.push('');
  }

  if (item.requirementIds.length > 0) {
    lines.push(`**Rastreabilidade:** ${item.requirementIds.join(', ')} (ver requirements.json)`);
    lines.push('');
  }

  lines.push('---');

  return lines.join('\n');
}

export function renderBacklogMarkdown(items: BacklogItem[]): string {
  return items.map((item) => renderBacklogItemMarkdown(item)).join('\n\n');
}

const ITEM_SPLIT_REGEX = /(?=^### \[Sprint \d+\])/m;
const HEADING_REGEX = /^### \[Sprint (\d+)\] (.+)$/m;
const META_REGEX =
  /<!--\s*sdd-bot:meta\s+id="([^"]*)"\s+epic="([^"]*)"\s+layer="([^"]*)"\s+requirementIds="([^"]*)"(?:\s+dependsOn="([^"]*)")?\s*-->/;

/** Ids de requisito gravados no comentário de metadados de um corpo de issue publicada. */
export function parseRequirementIdsFromBody(body: string | null | undefined): string[] {
  const match = META_REGEX.exec(body ?? '');
  return parseCommaList(match?.[4] ?? '');
}
const TYPE_REGEX = /^\*\*Tipo:\*\*\s*(feature|bug|tech-debt|refactor|docs)\s*$/m;
const PRIORITY_REGEX = /^\*\*Prioridade:\*\*\s*(must|should|could)\s*$/m;
const LABELS_REGEX = /^\*\*Labels:\*\*\s*(.*)$/m;
const DESCRIPTION_REGEX = /\*\*Descrição:\*\*\n([\s\S]*?)\n\n/;
const REPRO_STEPS_REGEX = /\*\*Passos para reproduzir:\*\*\n([\s\S]*?)\n\n/;
const EXPECTED_BEHAVIOR_REGEX = /\*\*Comportamento esperado:\*\*\n([\s\S]*?)\n\n/;
const ENVIRONMENT_REGEX = /^\*\*Ambiente:\*\*\s*(.*)$/m;
const ACCEPTANCE_REGEX = /\*\*Critérios de aceite:\*\*\n([\s\S]*?)(?:\n\n|\n---|$)/;
const SPECIFICITY_REGEX = /\*\*Especificidade técnica:\*\*\n([\s\S]*?)(?:\n\n|\n---|$)/;
const HTTP_CODES_REGEX = /^- Códigos HTTP:\s*(.*)$/m;
const FIELDS_REGEX = /^- Campos:\s*(.*)$/m;
const LIMITS_REGEX = /^- Limites:\s*(.*)$/m;
const CLARIFICATION_REGEX = /^- Precisa de esclarecimento:\s*(sim|não)(?:\s*—\s*(.*))?$/m;

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
  const [, id, epicRaw, layerRaw, requirementIdsRaw, dependsOnRaw] = metaMatch;
  const epic = unescapeAttr(epicRaw ?? '');
  const layer = layerRaw as BacklogItem['layer'];
  const requirementIds = parseCommaList(requirementIdsRaw ?? '');
  const dependsOn = parseCommaList(dependsOnRaw ?? '');

  const typeMatch = block.match(TYPE_REGEX);
  const type = (typeMatch?.[1] ?? 'feature') as BacklogItem['type'];

  const priorityMatch = block.match(PRIORITY_REGEX);
  const priority = (priorityMatch?.[1] ?? 'should') as BacklogItem['priority'];

  const labelsMatch = block.match(LABELS_REGEX);
  const labels = parseCommaList(labelsMatch?.[1] ?? '').map((label) => label.replace(/^`|`$/g, ''));

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

  const specificityMatch = SPECIFICITY_REGEX.exec(block);
  const technicalSpecificity = specificityMatch
    ? parseTechnicalSpecificity(specificityMatch[1] ?? '')
    : undefined;

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
    technicalSpecificity,
    labels,
    sprint,
    layer,
    requirementIds,
    dependsOn,
  };

  return BacklogItemSchema.parse(item);
}

function parseTechnicalSpecificity(text: string): TechnicalSpecificity {
  const clarification = CLARIFICATION_REGEX.exec(text);
  const needsClarification = clarification?.[1] === CLARIFICATION_YES;
  const note = clarification?.[2]?.trim();
  const limits = LIMITS_REGEX.exec(text)?.[1]?.trim();
  return {
    httpCodes: parseCommaList(HTTP_CODES_REGEX.exec(text)?.[1] ?? ''),
    fields: parseCommaList(FIELDS_REGEX.exec(text)?.[1] ?? '').map((field) => field.replace(/^`|`$/g, '')),
    limits: limits ? limits : null,
    needsClarification,
    clarificationNote: needsClarification ? (note ?? '') : null,
  };
}

function parseCommaList(text: string): string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
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
