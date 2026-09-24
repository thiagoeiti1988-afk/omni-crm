export const EMBEDDING_DIM = 1536;
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "hash-bow-1536";

function fnv(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic bag-of-words embedding so RAG works without a vendor key. */
export function embedText(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  if (tokens.length === 0) {
    vec[0] = 1;
    return vec;
  }
  for (const token of tokens) {
    const h = fnv(token);
    vec[h % dim] += 1;
    vec[(h + 97) % dim] += 0.35;
    vec[(h + 389) % dim] += 0.15;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function encodeEmbedding(vec: number[] | null): string | null {
  if (!vec) return null;
  return JSON.stringify(vec);
}

export function decodeEmbedding(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
