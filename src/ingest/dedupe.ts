function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** Similaridade de Jaccard entre os conjuntos de palavras de dois títulos. */
export function titleSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface SimilarPair<T> {
  a: T;
  b: T;
  similarity: number;
}

export function findSimilarPairs<T>(
  items: T[],
  getTitle: (item: T) => string,
  threshold: number,
): SimilarPair<T>[] {
  const pairs: SimilarPair<T>[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const itemA = items[i];
      const itemB = items[j];
      if (itemA === undefined || itemB === undefined) continue;
      const similarity = titleSimilarity(getTitle(itemA), getTitle(itemB));
      if (similarity >= threshold) {
        pairs.push({ a: itemA, b: itemB, similarity });
      }
    }
  }
  return pairs;
}
