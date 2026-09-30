/**
 * Server-side search service (stateless).
 *
 * IMPORTANT / honest architecture note:
 * Browser IndexedDB is origin-specific and CANNOT be read by the server.
 * Therefore the remote /api/v1/search endpoint searches exactly what the
 * caller submits in `corpus.documents` — it never fabricates results and
 * never claims to see the user's local index. Clients that want their local
 * corpus searched remotely must include it in the request (or use the
 * client-side `localSearch.search()` inside the browser instead).
 */

import { InvertedIndex } from "@/lib/indexing/inverted-index";
import { SearchEngine, type EngineOptions } from "@/lib/search/engine";
import type { RankWeights, SearchDocument, SearchResponse } from "@/types";
import { DEFAULT_RANK_WEIGHTS } from "@/types";

export interface CorpusDocument {
  id?: string;
  url: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  content?: string;
  headings?: string[];
  keywords?: string[];
  source?: string;
  language?: string;
  indexedAt?: string;
  updatedAt?: string;
}

const MAX_CORPUS_DOCS = 200;
const MAX_DOC_CHARS = 200_000;

function normalizeCorpus(corpus: CorpusDocument[]): Map<string, SearchDocument> {
  const now = new Date().toISOString();
  const docs = new Map<string, SearchDocument>();
  for (let i = 0; i < corpus.length && docs.size < MAX_CORPUS_DOCS; i++) {
    const c = corpus[i];
    const id = c.id ?? `srv_${i.toString(36)}`;
    if (docs.has(id)) continue;
    const doc: SearchDocument = {
      id,
      url: c.url,
      canonicalUrl: c.canonicalUrl || c.url,
      title: String(c.title ?? "").slice(0, 500),
      description: String(c.description ?? "").slice(0, 2000),
      content: String(c.content ?? "").slice(0, MAX_DOC_CHARS),
      headings: (c.headings ?? []).map((h) => String(h).slice(0, 500)).slice(0, 200),
      keywords: (c.keywords ?? []).map((k) => String(k).slice(0, 100)).slice(0, 100),
      source: c.source ?? safeHost(c.url),
      language: c.language ?? "en",
      contentHash: "",
      indexedAt: c.indexedAt ?? now,
      updatedAt: c.updatedAt ?? now,
    };
    docs.set(id, doc);
  }
  return docs;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

export interface ServerSearchResultBundle {
  response: SearchResponse;
  documents: Map<string, SearchDocument>;
  index: InvertedIndex;
}

export function serverSearchBundle(
  query: string,
  corpus: CorpusDocument[],
  options: EngineOptions & { weights?: RankWeights } = {}
): ServerSearchResultBundle {
  const docs = normalizeCorpus(corpus);
  const index = new InvertedIndex();
  for (const d of docs.values()) {
    index.addDocument(d.id, InvertedIndex.documentText(d), options.stemming ?? false);
  }
  const engine = new SearchEngine(index, docs);
  const startedAt = Date.now();
  const bundle = engine.search(query, options);
  const tookMs = Math.max(1, Date.now() - startedAt);
  const response = engine.toResponse(query, bundle, tookMs, {
    ...options,
    weights: options.weights ?? DEFAULT_RANK_WEIGHTS,
  });
  return { response, documents: docs, index };
}

export function serverSearch(
  query: string,
  corpus: CorpusDocument[],
  options: EngineOptions = {}
): SearchResponse {
  return serverSearchBundle(query, corpus, options).response;
}
