import type { BacklogItem } from '../schemas/backlog-item.js';

/**
 * Ordem de publicação: um item só é criado depois das issues das quais depende, para que o
 * corpo possa citar `#N` numa única passada. Kahn estável: percorre na ordem original
 * (sprint → id) e emite o primeiro item cujas dependências internas ao conjunto já saíram.
 * Dependências fora do conjunto (outra camada já publicada, ou não publicada) não bloqueiam.
 */
export function sortTopologically(items: BacklogItem[]): BacklogItem[] {
  assertAcyclic(items);

  const ownerByRequirement = ownersByRequirementId(items);
  const pending = [...items];
  const emitted = new Set<BacklogItem>();
  const ordered: BacklogItem[] = [];

  while (pending.length > 0) {
    const index = pending.findIndex((item) => internalDependencies(item, ownerByRequirement).every((dep) => emitted.has(dep)));
    // Sem ciclo, sempre existe um item livre.
    const next = pending.splice(index === -1 ? 0 : index, 1)[0]!;
    emitted.add(next);
    ordered.push(next);
  }

  return ordered;
}

/**
 * Agrupa em camadas: cada camada só depende de itens de camadas anteriores, então dois itens
 * da mesma camada nunca dependem um do outro e podem ser publicados em paralelo (Sprint de
 * otimização — criação de issues deixa de ser uma chamada por vez). Dentro de cada camada, a
 * ordem relativa original é preservada.
 */
export function topologicalLayers(items: BacklogItem[]): BacklogItem[][] {
  assertAcyclic(items);

  const ownerByRequirement = ownersByRequirementId(items);
  let pending = [...items];
  const emitted = new Set<BacklogItem>();
  const layers: BacklogItem[][] = [];

  while (pending.length > 0) {
    const ready: BacklogItem[] = [];
    const blocked: BacklogItem[] = [];
    for (const item of pending) {
      if (internalDependencies(item, ownerByRequirement).every((dep) => emitted.has(dep))) {
        ready.push(item);
      } else {
        blocked.push(item);
      }
    }
    for (const item of ready) emitted.add(item);
    layers.push(ready);
    pending = blocked;
  }

  return layers;
}

function assertAcyclic(items: BacklogItem[]): void {
  const cycle = findDependencyCycle(items);
  if (cycle) {
    throw new Error(`ciclo de dependências entre requisitos: ${cycle.join(' → ')}. Corrija "dependencies" em requirements.json antes de publicar.`);
  }
}

/**
 * Devolve o primeiro ciclo encontrado como sequência de ids de requisito (fechada no início),
 * ou undefined. Só considera dependências entre itens do conjunto.
 */
export function findDependencyCycle(items: BacklogItem[]): string[] | undefined {
  const ownerByRequirement = ownersByRequirementId(items);
  const state = new Map<BacklogItem, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (item: BacklogItem): string[] | undefined => {
    const current = state.get(item);
    if (current === 'done') return undefined;
    const requirementId = item.requirementIds[0] ?? item.id;
    if (current === 'visiting') {
      const start = stack.indexOf(requirementId);
      return [...stack.slice(start), requirementId];
    }
    state.set(item, 'visiting');
    stack.push(requirementId);
    for (const dep of internalDependencies(item, ownerByRequirement)) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(item, 'done');
    return undefined;
  };

  for (const item of items) {
    const found = visit(item);
    if (found) return found;
  }
  return undefined;
}

function ownersByRequirementId(items: BacklogItem[]): Map<string, BacklogItem> {
  const map = new Map<string, BacklogItem>();
  for (const item of items) {
    for (const id of item.requirementIds) {
      if (!map.has(id)) map.set(id, item);
    }
  }
  return map;
}

function internalDependencies(item: BacklogItem, ownerByRequirement: Map<string, BacklogItem>): BacklogItem[] {
  const deps: BacklogItem[] = [];
  for (const id of item.dependsOn) {
    const owner = ownerByRequirement.get(id);
    if (owner && owner !== item && !deps.includes(owner)) deps.push(owner);
  }
  return deps;
}
