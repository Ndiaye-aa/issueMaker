const SPRINT_COLOR = '0366D6';
const FEATURE_COLOR = '28A745';
const BUG_COLOR = 'D73A4A';
const PRIORITY_MUST_COLOR = 'B60205';
const PRIORITY_SHOULD_COLOR = 'D93F0B';
const PRIORITY_COULD_COLOR = 'BFD4F2';

export function normalizeLabelName(raw: string): string {
  const normalized = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, 20);
}

export function getLabelColor(label: string): string {
  if (label.startsWith('sprint-')) return SPRINT_COLOR;
  if (label === 'feature') return FEATURE_COLOR;
  if (label === 'bug') return BUG_COLOR;
  if (label === 'priority-must') return PRIORITY_MUST_COLOR;
  if (label === 'priority-should') return PRIORITY_SHOULD_COLOR;
  if (label === 'priority-could') return PRIORITY_COULD_COLOR;
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}
