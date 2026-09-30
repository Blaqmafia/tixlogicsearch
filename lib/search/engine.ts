/**
 * Core search pipeline shared by the browser service layer and any server-side
 * evaluation over submitted data. Operates on an InvertedIndex + document map.
 */

import { InvertedIndex } from "@/lib/indexing/inverted-index";
import { parseQuery, type ParsedQuery } from "@/lib/search/tokenizer";
import { rankDocuments, suppressDuplicates, type ScoredDoc } from "@/lib/ranking/ranker";
import type { RankWeights, SearchDocument, SearchResponse, SearchResult } from "@/types";

export interface EngineOptions {
  algorithm?: "bm25" | "tfidf";
  weights?: Partial<RankWeights>;
  stemming?: boolean;
  stopWords?: Set<string>;
  domain?: string;
  sort?: "relevance" | "date" | "title";
  limit?: number;
  page?: number;
}

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 10;

/** Build a snippet around the first matched term occurrence in the content. */
export function buildSnippet(content: string, terms: string[], length = 240): string {
  if (!content) return "";
  const lower = content.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = lower.indexOf(t);
    if (p !== -1 && (pos === -1 || p < pos)) pos = p;
  }
  if (pos === -1) pos = 0;
  const start = Math.max(0, pos - Math.floor(length / 3));
  const end = Math.min(content.length, start + length);
  let snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < content.length) snippet += "…";
  return snippet;
}

export interface EngineResultBundle {
  parsed: ParsedQuery;
  scored: ScoredDoc[];
  results: SearchResult[];
  total: number;
}

export class SearchEngine {
  private index: InvertedIndex;
  private docs: Map<string, SearchDocument>;

  constructor(index: InvertedIndex, docs: Map<string, SearchDocument>) {
    this.index = index;
    this.docs = docs;
  }

  static fromDocuments(documents: SearchDocument[], stemming = false): SearchEngine {
    const index = new InvertedIndex();
    const map = new Map<string, SearchDocument>();
    for (const doc of documents) {
      map.set(doc.id, doc);
      index.addDocument(doc.id, InvertedIndex.documentText(doc), stemming);
    }
    return new SearchEngine(index, map);
  }

  get documentCount(): number {
    return this.docs.size;
  }

  get termCount(): number {
    return this.index.termCount;
  }

  search(query: string, options: EngineOptions = {}): EngineResultBundle {
    const parsed = parseQuery(query, {
      stemming: options.stemming ?? false,
      stopWords: options.stopWords,
    });
    const fields: Record<string, { title: string; headings: string[]; keywords: string[]; indexedAt: string }> = {};
    for (const [id, d] of this.docs.entries()) {
      fields[id] = { title: d.title, headings: d.headings, keywords: d.keywords, indexedAt: d.indexedAt };
    }

    // Domain filter narrows candidates before ranking.
    let candidates: string[] | undefined;
    if (options.domain) {
      const dom = options.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      candidates = this.index
        .union(parsed.searchTokens.length ? parsed.searchTokens : [""])
        .filter((id) => {
          const doc = this.docs.get(id);
          if (!doc) return false;
          try {
            const host = new URL(doc.canonicalUrl || doc.url).hostname.toLowerCase();
            return host === dom || host.endsWith("." + dom);
          } catch {
            return false;
          }
        });
      if (parsed.searchTokens.length === 0) {
        candidates = [...this.docs.keys()].filter((id) => {
          const doc = this.docs.get(id)!;
          try {
            const host = new URL(doc.canonicalUrl || doc.url).hostname.toLowerCase();
            return host === dom || host.endsWith("." + dom);
          } catch {
            return false;
          }
        });
      }
    }

    let scored = rankDocuments({
      index: this.index,
      terms: parsed.searchTokens,
      phrases: parsed.phrases,
      algorithm: options.algorithm ?? "bm25",
      weights: options.weights,
      fields,
      candidates,
    });

    // Duplicate-content suppression: best-scoring copy wins.
    const order = new Map(scored.map((s, i) => [s.id, i]));
    const dupGroup = scored.map((s) => this.docs.get(s.id)!).filter(Boolean);
    const { kept, dropped } = suppressDuplicates(dupGroup, order);
    const keptIds = new Set(kept.map((k) => k.id));
    const duplicateOf = new Map<string, string>();
    for (const { dup, of } of dropped) duplicateOf.set(dup.id, of.id);
    scored = scored.filter((s) => keptIds.has(s.id));

    // Sorting
    if (options.sort === "date") {
      scored.sort((a, b) => Date.parse(this.docs.get(b.id)?.indexedAt || 0) - Date.parse(this.docs.get(a.id)?.indexedAt || 0));
    } else if (options.sort === "title") {
      scored.sort((a, b) => (this.docs.get(a.id)?.title || "").localeCompare(this.docs.get(b.id)?.title || ""));
    }

    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const page = Math.max(1, options.page ?? 1);
    const total = scored.length;
    const startIdx = (page - 1) * limit;
    const pageSlice = scored.slice(startIdx, startIdx + limit);

    const results: SearchResult[] = [];
    for (const s of pageSlice) {
      const doc = this.docs.get(s.id);
      if (!doc) continue;
      results.push({
        id: doc.id,
        url: doc.url,
        canonicalUrl: doc.canonicalUrl,
        title: doc.title,
        description: doc.description,
        source: doc.source,
        language: doc.language,
        indexedAt: doc.indexedAt,
        updatedAt: doc.updatedAt,
        score: Number(s.score.toFixed(4)),
        matchedTerms: s.matchedTerms,
        snippet: buildSnippet(doc.content, s.matchedTerms),
        contentAvailable: doc.content.length > 0,
        duplicateOf: duplicateOf.get(doc.id) ?? null,
      });
    }
    return { parsed, scored, results, total };
  }

  toResponse(query: string, bundle: EngineResultBundle, tookMs: number, options: EngineOptions): SearchResponse {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const page = Math.max(1, options.page ?? 1);
    const totalPages = Math.max(1, Math.ceil(bundle.total / limit));
    return {
      query,
      normalizedQuery: bundle.parsed.normalized,
      tokens: bundle.parsed.searchTokens,
      results: bundle.results,
      pagination: {
        page,
        limit,
        total: bundle.total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      tookMs,
      indexSize: this.documentCount,
      scope: "local-index",
    };
  }
}
