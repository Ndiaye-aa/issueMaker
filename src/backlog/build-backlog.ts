import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import type { AIClient } from '../ai/provider.js';
import { buildBacklogBatchRequest, buildBacklogRequest } from '../ai/prompts/backlog.js';
import { log } from '../cli/logger.js';
import { renderBacklogMarkdown } from '../render/backlog-markdown.js';
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
  const needingReview = items.filter((item) => item.technicalSpecificity?.clarificationNote?.startsWith(MANUAL_REVIEW_NOTE_PREFIX));
  if (needingReview.length > 0) {
    log.warn(
      `backlog ${layer}: ${needingReview.length} item(ns) marcado(s) para revisão manual (geração automática esgotou as tentativas) — ${needingReview.map((item) => item.requirementIds.join(',')).join('; ')}.`,
    );
  }
  return BacklogItemArraySchema.parse(items);
}

export interface BacklogByLayer {
  frontend: BacklogItem[];
  backend: BacklogItem[];
}

/**
 * Gera e grava backlog-frontend.md e backlog-backend.md em `outDir`. As duas camadas
 * filtram requisitos disjuntos e não compartilham estado, então rodam em paralelo — o
 * rate-limit real já é controlado pelo cliente de IA (semáforo por provedor), não por
 * quem chama, então isso não aumenta a concorrência efetiva, só evita ficar ocioso
 * entre o fim de uma camada e o início da outra.
 */
export async function buildAndWriteBacklogs(
  requirements: Requirement[],
  sprintPlan: SprintPlan,
  aiClient: AIClient,
  outDir: string,
  options: BuildBacklogOptions = {},
): Promise<BacklogByLayer> {
  const [frontend, backend] = await Promise.all([
    buildBacklogForLayer('frontend', requirements, sprintPlan, aiClient, options),
    buildBacklogForLayer('backend', requirements, sprintPlan, aiClient, options),
  ]);

  await Promise.all(
    (
      [
        ['frontend', frontend],
        ['backend', backend],
      ] as const
    ).map(async ([layer, items]) => {
      const outPath = join(outDir, `backlog-${layer}.md`);
      await writeFile(outPath, renderBacklogMarkdown(items), 'utf-8');
      console.log(`${items.length} item(ns) de backlog (${layer}) → ${outPath}`);
    }),
  );

  return { frontend, backend };
}

/**
 * Um lote é independente dos outros (ver comentário em buildBacklogForLayer), mas o
 * Promise.all de buildAndWriteBacklogs não é: se um lote esgotasse as tentativas de correção
 * de qualidade e propagasse o erro, TODO o backlog (as duas camadas, todos os outros lotes já
 * resolvidos) era descartado — nada era escrito em disco. Em vez disso, um lote que falhe
 * assim vira item(ns) marcados para revisão manual (`needsClarification`), preservando o
 * resto do backlog. Reexecutar depois (para corrigir o item manualmente ou só tentar de novo)
 * não reprocessa nem cobra de novo os lotes que já tinham dado certo: `CachedAIClient`
 * (../ai/cache.ts) só grava em disco respostas que já passaram no schema, então o cache só
 * tem miss para o lote que falhou.
 */
async function runBatch(
  batch: RequirementBatch,
  layer: BacklogLayer,
  requirements: Requirement[],
  aiClient: AIClient,
): Promise<BacklogItem[]> {
  log.step(batch.label);
  const exclusiveLayer = layer as Exclude<BacklogLayer, 'shared'>;

  try {
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
  } catch (error) {
    log.warn(`${batch.label}: geração falhou após esgotar as tentativas (${summarizeError(error)}); marcando para revisão manual em vez de descartar o restante do backlog.`);
    return batch.requirements.map((requirement) =>
      fallbackBacklogItem(requirement, batch.sprint, layer, requirements, error),
    );
  }
}

function summarizeError(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => issue.message).join('; ');
  return error instanceof Error ? error.message : String(error);
}

export const MANUAL_REVIEW_NOTE_PREFIX = 'Geração automática falhou';

/**
 * Item mínimo, válido pelo schema, para um requisito cuja geração por IA esgotou as
 * tentativas (ver runBatch). `needsClarification: true` já faz o publish marcar a issue com
 * a label de status correspondente (labelsForItem em publish-backlog.ts), então ela não passa
 * despercebida — mas o requisito não desaparece do backlog.
 */
function fallbackBacklogItem(
  requirement: Requirement,
  sprint: Sprint,
  layer: BacklogLayer,
  requirements: Requirement[],
  error: unknown,
): BacklogItem {
  const requirementIds = [requirement.id];
  return {
    id: '',
    epic: requirement.sourceSection,
    type: 'feature',
    title: `Revisar manualmente: ${requirement.title}`.slice(0, 70),
    description: `A geração automática deste item esgotou as tentativas de correção de qualidade. Requisito original: ${requirement.description}`.slice(0, 900),
    expectedBehavior: 'Revisar o requisito original e preencher descrição, comportamento esperado e critérios de aceite manualmente antes de publicar.',
    acceptanceCriteria: ['Revisão manual concluída antes da publicação desta issue.'],
    technicalSpecificity: {
      httpCodes: [],
      fields: [],
      limits: null,
      needsClarification: true,
      clarificationNote: `${MANUAL_REVIEW_NOTE_PREFIX}: ${summarizeError(error)}`.slice(0, 900),
    },
    labels: [],
    sprint: sprint.number,
    layer,
    requirementIds,
    dependsOn: resolveDependsOn(requirement, requirements),
    priority: resolvePriority(requirementIds, requirements),
  };
}

function resolveDependsOn(requirement: Requirement, requirements: Requirement[]): string[] {
  const knownIds = new Set(requirements.map((r) => r.id));
  return [...new Set(requirement.dependencies)].filter((id) => id !== requirement.id && knownIds.has(id));
}

function toBacklogItem(
  draft: BacklogItemDraft,
  requirement: Requirement,
  sprint: Sprint,
  layer: BacklogLayer,
  requirements: Requirement[],
): BacklogItem {
  const requirementIds = [requirement.id];
  const dependsOn = resolveDependsOn(requirement, requirements);
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
