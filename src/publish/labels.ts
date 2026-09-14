/**
 * Labels respondem "o quê" (categoria atemporal) e são sempre derivadas de dado
 * estruturado — nunca de texto livre do modelo. Uma label por dimensão, no formato
 * `dimensão: valor`, com uma família de cor por dimensão para escaneio visual.
 */
export type LabelDimension = 'type' | 'layer' | 'priority' | 'area' | 'status';

export const BOT_LABEL = 'sdd-bot';
export const NEEDS_CLARIFICATION_STATUS = 'needs-clarification';

/** Limite do GitHub para nomes de label. */
const GITHUB_LABEL_MAX_LENGTH = 50;
const DEFAULT_VALUE_MAX_LENGTH = 20;
const AREA_VALUE_MAX_LENGTH = 40;

const TYPE_COLORS: Record<string, string> = { feature: '1D76DB', bug: '0052CC', 'tech-debt': '5EA0F5' };
const PRIORITY_COLORS: Record<string, string> = { must: 'B60205', should: 'D93F0B', could: 'F9A38A' };
const LAYER_COLORS: Record<string, string> = { frontend: '5319E7', backend: '8A63D2' };
const TYPE_FAMILY_FALLBACK = '1D76DB';
const PRIORITY_FAMILY_FALLBACK = 'D93F0B';
const LAYER_FAMILY_FALLBACK = '5319E7';
const STATUS_COLOR = 'FBCA04';
const BOT_COLOR = 'EDEDED';

export function normalizeLabelName(raw: string, maxLength = DEFAULT_VALUE_MAX_LENGTH): string {
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, maxLength).replace(/-$/, '');
}

/** Seções do SDD costumam vir numeradas ("4.3 Modelo de dados"); a numeração não é área. */
function stripSectionNumber(value: string): string {
  return value.replace(/^\s*\d+(\.\d+)*\.?\s*/, '');
}

export function formatLabel(dimension: LabelDimension, value: string): string {
  const normalizedValue =
    dimension === 'area'
      ? normalizeLabelName(stripSectionNumber(value), AREA_VALUE_MAX_LENGTH)
      : normalizeLabelName(value);
  if (normalizedValue.length === 0) return '';
  return `${dimension}: ${normalizedValue}`.slice(0, GITHUB_LABEL_MAX_LENGTH);
}

export function parseLabel(label: string): { dimension: LabelDimension; value: string } | undefined {
  const match = /^(type|layer|priority|area|status): (.+)$/.exec(label);
  if (!match) return undefined;
  return { dimension: match[1] as LabelDimension, value: match[2] ?? '' };
}

/**
 * Cores fixas por família de dimensão (todas `type:*` em azul, `priority:*` em vermelho/
 * laranja, `layer:*` em roxo, `area:*` em tons de verde derivados do nome), para que
 * reexecuções e repositórios diferentes recebam sempre a mesma cor por label.
 */
export function getLabelColor(label: string): string {
  if (label === BOT_LABEL) return BOT_COLOR;
  const parsed = parseLabel(label);
  if (!parsed) return hashShade(label);
  switch (parsed.dimension) {
    case 'type':
      return TYPE_COLORS[parsed.value] ?? TYPE_FAMILY_FALLBACK;
    case 'priority':
      return PRIORITY_COLORS[parsed.value] ?? PRIORITY_FAMILY_FALLBACK;
    case 'layer':
      return LAYER_COLORS[parsed.value] ?? LAYER_FAMILY_FALLBACK;
    case 'status':
      return STATUS_COLOR;
    case 'area':
      return hashShade(parsed.value);
  }
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Tom de verde determinístico: matiz fixo (~140°), luminosidade e saturação variam com o
 * hash do nome, sempre claras o bastante para o texto preto do GitHub ler bem.
 */
export function hashShade(input: string): string {
  const hash = fnv1a(input);
  const hue = 130 + (hash % 25); // 130..154: família verde
  const saturation = 45 + ((hash >>> 8) % 30); // 45..74%
  const lightness = 55 + ((hash >>> 16) % 25); // 55..79%
  return hslToHex(hue, saturation, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)]
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}
