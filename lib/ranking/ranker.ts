/**
 * Custom ranking engine: BM25, TF-IDF, field boosts (title/headings/keywords),
 * exact-phrase matching via positions, freshness signal and duplicate suppression.
 * Pure functions — no platform APIs.
 */

import type { RankWeights, RankingAlgorithm } from "@/types";
import { DEFAULT_RANK_WEIGHTS } from "@/types";
import type { InvertedIndex } from "@/lib/indexing/inverted-index";
import { tokenize } from "@/lib/search/tokenizer";

export interface ScoredDoc {
  id: string;
  score: number;
  matchedTerms: string[];
}

export interface RankingInput {
  index: InvertedIndex;
  terms: string[]; // query terms for posting lookup (already normalized/stemmed)
  phrases: string[]; // exact phrases (lowercased, unstemmed)
  algorithm?: RankingAlgorithm;
  weights?: RankWeights | Partial<RankWeights>;
  /** docId -> fields used for field-level boosting */
  fields: Record<string, { title: string; headings: string[]; keywords: string[]; indexedAt: string }>;
  /** restrict candidate ids (e.g. after domain filter / AND pass) */
  candidates?: string[];
  now?: number;
  bm25Params?: { k1: number; b: number };
}

const BM25_DEFAULTS = { k1: 1.5, b: 0.75 };

/** Classic Okapi BM25 contribution for one term in one document. */
export function bm25Score(
  tf: number,
  df: number,
  N: number,
  dl: number,
  avgdl: number,
  k1 = BM25_DEFAULTS.k1,
  b = BM25_DEFAULTS.b
): number {
  if (df === 0 || N === 0) return 0;
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  const denom = tf + k1 * (1 - b + (b * dl) / (avgdl || 1));
  return idf * ((tf * (k1 + 1)) / denom);
}

/** Luhn-style TF with Robertson–Sparck Jones IDF. */
export function tfidfScore(tf: number, df: number, N: number, dl: number): number {
  if (tf === 0 || df === 0 || N === 0 || dl === 0) return 0;
  const normTf = 1 + Math.log(tf);
  const idf = Math.log(N / df);
  // length normalization sqrt(dl) (cosine-ish without vector magnitude)
  return (normTf * idf) / Math.sqrt(dl);
}

/** Does the document token stream contain the phrase contiguously? Uses postings positions. */
export function phraseMatches(index: InvertedIndex, phrase: string, docId: string, stemming: boolean): boolean {
  const words = tokenize(phrase).filter((w) => w.length > 0);
  if (words.length === 0) return false;
  const terms = stemming ? words : words;
  const positionLists: number[][] = [];
  for (const t of terms) {
    const p = index.getPosting(t);
    if (!p || !p.positions[docId]) return false;
    positionLists.push(p.positions[docId]);
  }
  if (positionLists.length === 1) return true;
  // check consecutive positions
  const first = positionLists[0];
  for (const start of first) {
    let ok = true;
    for (let i = 1; i < positionLists.length; i++) {
      if (!binaryHas(positionLists[i], start + i)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function binaryHas(sorted: number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === value) return true;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Exponential-decay freshness in [0,1], half-life ~30 days. */
export function freshnessScore(indexedAt: string, now = Date.now()): number {
  const t = Date.parse(indexedAt);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, (now - t) / 86400000);
  return Math.exp(-Math.LN2 * (ageDays / 30));
}

export function rankDocuments(input: RankingInput): ScoredDoc[] {
  const weights = { ...DEFAULT_RANK_WEIGHTS, ...(input.weights || {}) };
  const algorithm = input.algorithm ?? "bm25";
  const now = input.now ?? Date.now();
  const { k1, b } = input.bm25Params ?? BM25_DEFAULTS;

  const index = input.index;
  const N = index.documentCount;
  if (N === 0 || input.terms.length === 0) return [];
  const avgdl = index.averageDocumentLength();

  const candidates =
    input.candidates && input.candidates.length > 0 ? input.candidates : index.union(input.terms);

  const scored: ScoredDoc[] = [];
  for (const docId of candidates) {
    const stats = index.getDocumentStats(docId);
    if (!stats) continue;
    let score = 0;
    const matched: string[] = [];
    for (const term of input.terms) {
      const posting = index.getPosting(term);
      if (!posting || !(term in posting.termFrequencies) ) continue;
      const tf = posting.termFrequencies[docId] ?? 0;
      if (tf === 0) continue;
      matched.push(term);
      const df = posting.documentIds.length;
      if (algorithm === "bm25") {
        score += weights.bm25 * bm25Score(tf, df, N, stats.length, avgdl, k1, b);
      } else {
        score += weights.tfidf * tfidfScore(tf, df, N, stats.length) * 10;
      }
    }
    if (matched.length === 0) continue;

    const fields = input.fields[docId];
    if (fields) {
      // Title relevance: fraction of query terms appearing in the title.
      const titleTokens = new Set(tokenize(fields.title));
      let titleHits = 0;
      for (const term of input.terms) if (titleTokens.has(term)) titleHits++;
      if (titleHits > 0) {
        score += weights.title * (titleHits / input.terms.length) * Math.max(1, Math.log2(N + 1));
      }
      // Heading relevance
      const headingText = fields.headings.join(" ").toLowerCase();
      let headHits = 0;
      for (const term of input.terms) if (headingText.includes(term)) headHits++;
      if (headHits > 0) score += weights.headings * (headHits / input.terms.length);
      // Keyword relevance
      const kw = new Set(fields.keywords.map((k) => k.toLowerCase()));
      let kwHits = 0;
      for (const term of input.terms) if (kw.has(term)) kwHits++;
      if (kwHits > 0) score += weights.keywords * (kwHits / input.terms.length);
      // Freshness
      score += weights.freshness * freshnessScore(fields.indexedAt, now);
    }

    // Exact phrase bonus (positions verified)
    for (const phrase of input.phrases) {
      if (phraseMatches(index, phrase, docId, false)) {
        score += weights.phrase * (1 + Math.log2(N + 1));
      }
    }

    scored.push({ id: docId, score, matchedTerms: matched });
  }

  scored.sort((a, b2) => b2.score - a.score);
  return scored;
}

/**
 * Duplicate-content suppression: keep only the highest-scoring document per
 * contentHash group; the rest are marked as duplicates by the caller.
 */
export function suppressDuplicates<T extends { id: string; contentHash: string }>(
  docs: T[],
  order: Map<string, number>
): { kept: T[]; dropped: Array<{ dup: T; of: T }> } {
  const seen = new Map<string, T>();
  const kept: T[] = [];
  const dropped: Array<{ dup: T; of: T }> = [];
  const sorted = [...docs].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const d of sorted) {
    const prev = seen.get(d.contentHash);
    if (prev) dropped.push({ dup: d, of: prev });
    else {
      seen.set(d.contentHash, d);
      kept.push(d);
    }
  }
  return { kept, dropped };
}
