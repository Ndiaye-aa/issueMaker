import type { AIClient } from '../ai/provider.js';
import { buildBacklogBatchRequest, buildBacklogRequest } from '../ai/prompts/backlog.js';
import { log } from '../cli/logger.js';
import {
  BacklogItemArraySchema,
  BacklogItemBatchDraftSchema,
  BacklogItemDraftSchema,
  type BacklogItem,
  type BacklogItemBatchDraft,
  type BacklogItemDraft,
  type BacklogLayer,
} from '../schemas/backlog-item.js';
import { normalizeText } from '../schemas/backlog-quality.js';
import { findDependencyCycle } from '../publish/dependency-order.js';
import { resolvePriority } from './priority.js';
import type { Requirement } from '../schemas/requirement.js';
import type { Sprint, SprintPlan } from '../schemas/sprint-plan.js';
import { mapWithConcurrency } from '../util/concurrency.js';

const MAX_FAN_OUT = 8;
/** 1 requisito por chamada: sem agrupamento, cada issue tem uma chamada só para si. */
const DEFAULT_BATCH_SIZE = 1;

/**
 * Requisitos "shared" (infra, modelo de dados, segurança transversal...) não têm arquivo
 * próprio; sem esta regra eles simplesmente sumiam do backlog. Vão para o backend, que é
 * onde esse tipo de trabalho normalmente começa.
 */
export const SHARED_TARGET_LAYER: BacklogLayer = 'backend';

export function belongsToLayer(requirement: Requirement, layer: BacklogLayer): boolean {
  return requirement.layer === layer || (requirement.layer === 'shared' && layer === SHARED_TARGET_LAYER);
}

export interface BuildBacklogOptions {
  /**
   * Quantos requisitos da mesma sprint entram numa única chamada de IA. O system prompt
   * (a maior parte da entrada) é reenviado uma vez por chamada, então lotes maiores gastam
   * bem menos tokens; o contrapeso é que o modelo vê vários requisitos de uma vez, e prompts
   * pequenos/locais (Ollama) tendem a perder rigor nesse modo — force 1 nesse caso.
   * Default 1 (uma chamada por requisito).
   */
  batchSize?: number;
}

interface RequirementBatch {
  sprint: Sprint;
  requirements: Requirement[];
  label: string;
}

/**
 * Tudo que é dado estruturado (sprint, camada, épico, rastreabilidade) é preenchido aqui,
 * nunca pelo modelo — só os campos de aiGeneratedShape vêm da IA.
 */
export async function buildBacklogForLayer(
  layer: BacklogLayer,
  requirements: Requirement[],
  sprintPlan: SprintPlan,
  aiClient: AIClient,
  options: BuildBacklogOptions = {},
): Promise<BacklogItem[]> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));

  const batches: RequirementBatch[] = [];
  for (const sprint of sprintPlan.sprints) {
    const ids = new Set(sprint.requirementIds);
    const scoped = requirements.filter((r) => ids.has(r.id) && belongsToLayer(r, layer));
    for (let i = 0; i < scoped.length; i += batchSize) {
      batches.push({ sprint, requirements: scoped.slice(i, i + batchSize), label: '' });
    }
  }
  batches.forEach((batch, index) => {
    const first = batch.requirements[0]!;
    const reqLabel =
      batch.requirements.length === 1
        ? first.id
        : `${first.id}..${batch.requirements[batch.requirements.length - 1]!.id} (${batch.requirements.length} requisitos)`;
    batch.label = `backlog ${layer}: sprint ${batch.sprint.number} — ${reqLabel} (lote ${index + 1}/${batches.length})`;
  });

  // Lotes são independentes entre si: rodam em paralelo (limitado pelo cliente de IA) e o
  // resultado volta na ordem sprint → requisito, para que a numeração BL-xxx fique estável.
  const drafts = await mapWithConcurrency(batches, MAX_FAN_OUT, (batch) => runBatch(batch, layer, requirements, aiClient));

  const items = drafts.flat().map((item, index) => ({
    ...item,
    id: `BL-${String(index + 1).padStart(3, '0')}`,
  }));

  warnOnDuplicateTitles(items, layer);
  const cycle = findDependencyCycle(items);
  if (cycle) {
    log.warn(`backlog ${layer}: ciclo de dependências entre requisitos (${cycle.join(' → ')}); o publish vai recusar até ser corrigido em requirements.json.`);
  }
  return BacklogItemArraySchema.parse(items);
}

async function runBatch(
  batch: RequirementBatch,
  layer: BacklogLayer,
  requirements: Requirement[],
  aiClient: AIClient,
): Promise<BacklogItem[]> {
  log.step(batch.label);
  const exclusiveLayer = layer as Exclude<BacklogLayer, 'shared'>;

  if (batch.requirements.length === 1) {
    const requirement = batch.requirements[0]!;
    const request = buildBacklogRequest(exclusiveLayer, requirement, batch.sprint);
    const draft = await aiClient.complete(request, BacklogItemDraftSchema);
    return [toBacklogItem(draft, requirement, batch.sprint, layer, requirements)];
  }

  const ids = batch.requirements.map((r) => r.id);
  const request = buildBacklogBatchRequest(exclusiveLayer, batch.requirements, batch.sprint);
  const drafts = await aiClient.complete(request, BacklogItemBatchDraftSchema(ids));
  const draftById = new Map<string, BacklogItemBatchDraft>(drafts.map((draft) => [draft.requirementId, draft]));
  return batch.requirements.map((requirement) =>
    toBacklogItem(draftById.get(requirement.id)!, requirement, batch.sprint, layer, requirements),
  );
}

function toBacklogItem(
  draft: BacklogItemDraft,
  requirement: Requirement,
  sprint: Sprint,
  layer: BacklogLayer,
  requirements: Requirement[],
): BacklogItem {
  const requirementIds = [requirement.id];
  const knownIds = new Set(requirements.map((r) => r.id));
  const dependsOn = [...new Set(requirement.dependencies)].filter(
    (id) => id !== requirement.id && knownIds.has(id),
  );
  const reproSteps = draft.type === 'bug' ? draft.reproSteps : undefined;
  const environment = looksLikeEnvironment(draft.environment) ? draft.environment!.trim() : undefined;
  const spec = draft.technicalSpecificity;
  // Normaliza para o que o Markdown consegue representar (round-trip exato no publish).
  const technicalSpecificity = {
    httpCodes: spec.httpCodes.map((code) => code.trim()).filter(Boolean),
    fields: spec.fields.map((field) => field.trim()).filter(Boolean),
    limits: spec.limits?.trim() ? spec.limits.trim() : null,
    needsClarification: spec.needsClarification,
    clarificationNote: spec.needsClarification ? (spec.clarificationNote ?? '').trim() : null,
  };
  return {
    id: '',
    epic: requirement.sourceSection,
    type: draft.type,
    title: draft.title.trim(),
    description: draft.description,
    expectedBehavior: draft.expectedBehavior,
    ...(reproSteps ? { reproSteps } : {}),
    ...(environment ? { environment } : {}),
    acceptanceCriteria: draft.acceptanceCriteria,
    technicalSpecificity,
    labels: [],
    sprint: sprint.number,
    layer,
    requirementIds,
    dependsOn,
    priority: resolvePriority(requirementIds, requirements),
  };
}

const ENVIRONMENT_HINT_REGEX =
  /\b(chrome|firefox|safari|edge|opera|ios|android|windows|linux|ubuntu|debian|macos|mac os|node(\.js)?|java|python|postgres(ql)?|mysql|mongo(db)?|redis|docker|kubernetes|k8s|aws|azure|gcp|vers[aã]o|v?\d+\.\d+)\b/i;

/**
 * "environment" só faz sentido quando o SDD cita SO/navegador/runtime/versão. Modelos tendem
 * a reaproveitar o campo para repetir contexto ("Frontend — tela de cadastro, sprint 3"),
 * que já está em outras partes da issue; isso é descartado.
 */
export function looksLikeEnvironment(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 && ENVIRONMENT_HINT_REGEX.test(trimmed);
}

/**
 * Cada chamada vê um único requisito, então o modelo não consegue garantir títulos únicos.
 * A idempotência do `publish --mode add` é por título: duplicata = issue pulada em silêncio.
 */
function warnOnDuplicateTitles(items: BacklogItem[], layer: BacklogLayer): void {
  const byTitle = new Map<string, BacklogItem[]>();
  for (const item of items) {
    const key = normalizeText(item.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), item]);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const refs = group.map((item) => `${item.id} (${item.requirementIds.join(', ')})`).join(', ');
    log.warn(`backlog ${layer}: título repetido "${group[0]!.title}" em ${refs}; renomeie antes de publicar ou o modo add vai pular as duplicatas.`);
  }
}
