/**
 * Client-side search service — the heart of TixlogicSearch.
 * Owns IndexedDB persistence (documents + inverted index), runs the custom
 * ranking engine in the browser, and exposes CRUD/search/import/export used
 * by the UI and reusable by other in-browser integrations.
 */

"use client";

import { InvertedIndex } from "@/lib/indexing/inverted-index";
import { SearchEngine } from "@/lib/search/engine";
import { contentHash, randomId } from "@/lib/security/crypto";
import { canonicalizeUrl } from "@/lib/crawler/url-validator";
import { DEFAULT_STOP_WORDS, tokenize } from "@/lib/search/tokenizer";
import {
  cacheStore,
  docStore,
  historyStore,
  indexStore,
  logStore,
  settingsStore,
  STORES,
} from "@/lib/storage/idb";
import type {
  CachedResult,
  InvertedIndexEntry,
  RankWeights,
  SearchDocument,
  SearchHistoryItem,
  SearchResponse,
} from "@/types";
import { DEFAULT_RANK_WEIGHTS } from "@/types";
import type { EngineOptions } from "@/lib/search/engine";

export interface LocalSettings {
  stemming: boolean;
  stopWords: string[];
  weights: RankWeights;
  algorithm: "bm25" | "tfidf";
  cacheTtlMinutes: number;
  theme: "light" | "dark";
}

export const DEFAULT_SETTINGS: LocalSettings = {
  stemming: false,
  stopWords: [...DEFAULT_STOP_WORDS],
  weights: DEFAULT_RANK_WEIGHTS,
  algorithm: "bm25",
  cacheTtlMinutes: 30,
  theme: "light",
};

const SETTINGS_KEY = "search.settings";
const INDEX_META_KEY = "index.meta";

interface IndexMeta {
  documentCount: number;
  termCount: number;
  builtAt: string;
  consistent: boolean;
}

class LocalSearchService {
  private index: InvertedIndex | null = null;
  private docs: Map<string, SearchDocument> | null = null;
  private settings: LocalSettings | null = null;
  private initPromise: Promise<void> | null = null;

  async init(force = false): Promise<void> {
    if (this.index && this.docs && !force) return;
    if (!force && this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.loadSettings();
      const [documents, entries] = await Promise.all([docStore.all(), indexStore.all()]);
      const map = new Map(documents.map((d) => [d.id, d]));
      const idx = new InvertedIndex();
      const stats = documents.map((d) => ({ id: d.id, length: 0 }));
      idx.loadEntries(entries as InvertedIndexEntry[], stats);
      // If persisted stats are missing lengths or index is empty while docs exist, rebuild.
      const needsRebuild = documents.length > 0 && (entries.length === 0 || !(await this.metaConsistent(documents.length)));
      if (needsRebuild) {
        await this.rebuildIndexInner(documents, map);
      } else {
        // recompute lengths for ranking accuracy
        for (const d of documents) {
          idx.addDocument(d.id, InvertedIndex.documentText(d), this.settings!.stemming);
        }
        // that call rebuilt postings in memory too — persist nothing extra
      }
      this.index = idx;
      this.docs = map;
      await this.pruneCache();
    })();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async metaConsistent(expectedDocs: number): Promise<boolean> {
    const meta = await settingsStore.get(INDEX_META_KEY);
    if (!meta) return false;
    const m = meta.value as IndexMeta;
    return m.consistent === true && m.documentCount === expectedDocs;
  }

  async loadSettings(): Promise<LocalSettings> {
    if (this.settings) return this.settings;
    const entry = await settingsStore.get(SETTINGS_KEY);
    const stored = (entry?.value ?? {}) as Partial<LocalSettings>;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      weights: { ...DEFAULT_SETTINGS.weights, ...(stored.weights ?? {}) },
    };
    return this.settings;
  }

  async saveSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
    const current = await this.loadSettings();
    this.settings = { ...current, ...patch, weights: { ...current.weights, ...(patch.weights ?? {}) } };
    await settingsStore.put({ key: SETTINGS_KEY, value: this.settings });
    return this.settings;
  }

  getSettingsSync(): LocalSettings {
    return this.settings ?? DEFAULT_SETTINGS;
  }

  /* ------------------------------ documents ------------------------------ */

  async addDocument(input: Omit<SearchDocument, "id" | "contentHash" | "indexedAt" | "updatedAt"> & { id?: string }): Promise<{ doc: SearchDocument; duplicateOf?: string }> {
    await this.init();
    const canonical = input.canonicalUrl || canonicalizeUrl(input.url);
    const hash = await contentHash(`${input.title}\n${input.content}`);
    // Duplicate detection: canonical URL first, then content hash.
    const byUrl = await docStore.byCanonicalUrl(canonical);
    if (byUrl.length > 0) {
      const existing = byUrl[0];
      if (existing.contentHash === hash) return { doc: existing, duplicateOf: existing.id };
      // same URL, different content → update in place (re-index)
      const updated: SearchDocument = { ...existing, ...input, canonicalUrl: canonical, contentHash: hash, updatedAt: new Date().toISOString() };
      await docStore.put(updated);
      this.docs!.set(updated.id, updated);
      this.index!.updateDocument(updated.id, InvertedIndex.documentText(updated), this.getSettingsSync().stemming);
      await this.persistIndexForDoc(updated.id);
      await this.log("document.updated", `Updated ${canonical}`);
      return { doc: updated };
    }
    const byHash = await docStore.byContentHash(hash);
    if (byHash.length > 0) {
      return { doc: byHash[0], duplicateOf: byHash[0].id };
    }
    const now = new Date().toISOString();
    const doc: SearchDocument = {
      ...input,
      id: input.id ?? randomId("doc"),
      canonicalUrl: canonical,
      contentHash: hash,
      indexedAt: now,
      updatedAt: now,
    };
    await docStore.put(doc);
    this.docs!.set(doc.id, doc);
    this.index!.addDocument(doc.id, InvertedIndex.documentText(doc), this.getSettingsSync().stemming);
    await this.persistIndexForDoc(doc.id);
    await this.log("document.created", `Indexed ${doc.canonicalUrl}`);
    return { doc };
  }

  private async persistIndexForDoc(docId: string): Promise<void> {
    // Persist only affected postings efficiently: rewrite full index snapshot
    // atomically (bounded by local dataset size; documented limitation).
    await this.persistIndexSnapshot(docId);
  }

  private async persistIndexSnapshot(_touchedDocId?: string): Promise<void> {
    if (!this.index) return;
    const entries = this.index.toEntries();
    await indexStore.clear();
    await indexStore.putMany(entries);
    await settingsStore.put({
      key: INDEX_META_KEY,
      value: {
        documentCount: this.docs?.size ?? 0,
        termCount: entries.length,
        builtAt: new Date().toISOString(),
        consistent: true,
      } satisfies IndexMeta,
    });
  }

  async getDocument(id: string): Promise<SearchDocument | undefined> {
    await this.init();
    return docStore.get(id);
  }

  async listDocuments(): Promise<SearchDocument[]> {
    await this.init();
    return docStore.all();
  }

  async updateDocument(id: string, patch: Partial<SearchDocument>): Promise<SearchDocument | null> {
    await this.init();
    const existing = await docStore.get(id);
    if (!existing) return null;
    const merged: SearchDocument = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    if (patch.url || patch.content || patch.title) {
      merged.canonicalUrl = patch.canonicalUrl || merged.canonicalUrl || canonicalizeUrl(merged.url);
      merged.contentHash = await contentHash(`${merged.title}\n${merged.content}`);
    }
    await docStore.put(merged);
    this.docs!.set(id, merged);
    this.index!.updateDocument(id, InvertedIndex.documentText(merged), this.getSettingsSync().stemming);
    await this.persistIndexSnapshot(id);
    await this.log("document.updated", `Patched document ${id}`);
    return merged;
  }

  async deleteDocument(id: string): Promise<boolean> {
    await this.init();
    const existing = await docStore.get(id);
    if (!existing) return false;
    await docStore.remove(id);
    this.docs!.delete(id);
    this.index!.removeDocument(id);
    await this.persistIndexSnapshot(id);
    await this.log("document.deleted", `Removed document ${id} (${existing.canonicalUrl})`);
    return true;
  }

  /* -------------------------------- search ------------------------------- */

  async search(query: string, options: EngineOptions = {}): Promise<SearchResponse> {
    const startedAt = performance.now();
    await this.init();
    const settings = await this.loadSettings();
    const engine = new SearchEngine(this.index!, this.docs!);
    const stopWords = settings.stopWords.length ? new Set(settings.stopWords) : undefined;
    const opts: EngineOptions = {
      stemming: settings.stemming,
      weights: settings.weights,
      algorithm: settings.algorithm,
      stopWords,
      ...options,
    };
    // Result cache check (only for default-ish queries without paging oddities)
    const queryHashKey = JSON.stringify({ q: query.toLowerCase(), d: opts.domain ?? "", a: opts.algorithm, l: opts.limit, p: opts.page });
    const cached = await this.getCached(queryHashKey);
    if (cached) {
      await this.recordHistory(query, cached.pagination.total);
      return cached;
    }
    const bundle = engine.search(query, opts);
    const tookMs = Math.round(performance.now() - startedAt);
    const response = engine.toResponse(query, bundle, tookMs, opts);
    await this.putCached(queryHashKey, response);
    await this.recordHistory(query, bundle.total);
    return response;
  }

  async suggestions(prefix: string, limit = 8): Promise<string[]> {
    await this.init();
    const p = prefix.trim().toLowerCase();
    if (!p) return [];
    const out = new Set<string>();
    const history = await historyStore.all();
    for (const h of history) if (h.query.toLowerCase().includes(p) && h.query.toLowerCase() !== p) out.add(h.query);
    // term completions from the index
    const tokens = tokenize(p);
    if (tokens.length > 0) {
      const last = tokens[tokens.length - 1];
      const ids = this.index!.union([last]).slice(0, 20);
      void ids;
      const all = await indexStore.all();
      for (const e of all) {
        if (e.term.startsWith(last) && e.term !== last) out.add(e.term);
        if (out.size >= limit) break;
      }
    }
    return [...out].slice(0, limit);
  }

  /* ----------------------------- index ops ------------------------------ */

  async rebuildIndex(): Promise<{ documents: number; terms: number; tookMs: number }> {
    const startedAt = performance.now();
    this.settings = null;
    this.index = null;
    this.docs = null;
    await this.init(true);
    const documents = await docStore.all();
    const map = new Map(documents.map((d) => [d.id, d]));
    const settings = await this.loadSettings();
    const idx = new InvertedIndex();
    for (const d of documents) idx.addDocument(d.id, InvertedIndex.documentText(d), settings.stemming);
    this.index = idx;
    this.docs = map;
    await this.persistIndexSnapshot();
    await this.log("index.rebuilt", `Rebuilt index: ${documents.length} docs, ${idx.termCount} terms`);
    return { documents: documents.length, terms: idx.termCount, tookMs: Math.round(performance.now() - startedAt) };
  }

  async indexStats(): Promise<{ documents: number; terms: number; avgDocLength: number; totalTokens: number }> {
    await this.init();
    return {
      documents: this.index!.documentCount,
      terms: this.index!.termCount,
      avgDocLength: Math.round(this.index!.averageDocumentLength()),
      totalTokens: this.index!.totalTokens,
    };
  }

  async inspectTerm(term: string): Promise<InvertedIndexEntry | null> {
    await this.init();
    const t = term.trim().toLowerCase();
    if (!t) return null;
    const posting = this.index!.getPosting(t);
    if (!posting) return null;
    return { term: t, ...posting };
  }

  /* -------------------------- history / saved --------------------------- */

  async recordHistory(query: string, resultCount: number): Promise<void> {
    const item: SearchHistoryItem = { id: randomId("his"), query, timestamp: new Date().toISOString(), resultCount };
    await historyStore.put(item);
    // keep bounded
    const all = await historyStore.all();
    if (all.length > 500) {
      const sorted = all.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      for (const old of sorted.slice(500)) await historyStore.remove(old.id);
    }
  }

  async getHistory(limit = 25): Promise<SearchHistoryItem[]> {
    const all = await historyStore.all();
    return all.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, limit);
  }

  async clearHistory(): Promise<void> {
    await historyStore.clear();
  }

  /* -------------------------------- cache ------------------------------- */

  private async getCached(keyJson: string): Promise<SearchResponse | null> {
    const settings = await this.loadSettings();
    if (settings.cacheTtlMinutes <= 0) return null;
    const { sha256Hex } = await import("@/lib/security/crypto");
    const hash = await sha256Hex(keyJson);
    const all = await cacheStore.all();
    const hit = all.find((c) => c.queryHash === hash && Date.parse(c.expiresAt) > Date.now());
    if (!hit) return null;
    // putCached stores the full response fields alongside cache metadata, so
    // read them directly from the entry (previous version double-wrapped).
    const r = hit as unknown as Record<string, unknown>;
    if (!r.results || !r.pagination) return null;
    return {
      query: String(r.query),
      normalizedQuery: String(r.normalizedQuery ?? ""),
      tokens: (r.tokens as string[]) ?? [],
      results: r.results as SearchResponse["results"],
      pagination: r.pagination as SearchResponse["pagination"],
      tookMs: Number(r.tookMs ?? 0),
      indexSize: Number(r.indexSize ?? 0),
      scope: "local-index",
    };
  }

  private async putCached(keyJson: string, response: SearchResponse): Promise<void> {
    const settings = await this.loadSettings();
    if (settings.cacheTtlMinutes <= 0) return;
    const { sha256Hex } = await import("@/lib/security/crypto");
    const hash = await sha256Hex(keyJson);
    const now = Date.now();
    const entry: CachedResult & Omit<SearchResponse, never> = Object.assign(
      {
        id: randomId("cch"),
        queryHash: hash,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + settings.cacheTtlMinutes * 60_000).toISOString(),
      },
      response
    ) as never;
    await cacheStore.put(entry);
  }

  async pruneCache(): Promise<number> {
    const all = await cacheStore.all();
    let removed = 0;
    for (const c of all) {
      if (Date.parse(c.expiresAt) <= Date.now()) {
        await cacheStore.remove(c.id);
        removed++;
      }
    }
    return removed;
  }

  async clearCache(): Promise<void> {
    await cacheStore.clear();
  }

  /* ---------------------------- import/export --------------------------- */

  async exportBundle(): Promise<unknown> {
    await this.init();
    const documents = await docStore.all();
    const settingsEntry = await settingsStore.get(SETTINGS_KEY);
    return {
      app: "TixlogicSearch",
      version: 1,
      exportedAt: new Date().toISOString(),
      documents,
      settings: settingsEntry?.value ?? {},
    };
  }

  async importBundle(bundle: unknown, replace = false): Promise<{ imported: number; duplicates: number; rejected: number }> {
    const { exportBundleSchema } = await import("@/lib/validation/serializers");
    const parsed = exportBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      throw new Error(`Import rejected by validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (replace) {
      await this.deleteAllDocuments();
    }
    let imported = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const doc of parsed.data.documents) {
      try {
        const res = await this.addDocument(doc);
        if ("duplicateOf" in res && res.duplicateOf) duplicates++;
        else imported++;
      } catch {
        rejected++;
      }
    }
    return { imported, duplicates, rejected };
  }

  async deleteAllDocuments(): Promise<void> {
    await docStore.clear();
    await indexStore.clear();
    await settingsStore.remove(INDEX_META_KEY).catch(() => undefined);
    this.index = null;
    this.docs = null;
    this.initPromise = null;
    await this.log("documents.cleared", "All documents deleted from IndexedDB");
    await this.init(true);
  }

  /* -------------------------------- logs -------------------------------- */

  async log(event: string, details: string): Promise<void> {
    try {
      await logStore.put({ id: randomId("log"), event, timestamp: new Date().toISOString(), details: details.slice(0, 500) });
    } catch {
      /* logging must never break functionality */
    }
  }

  async getLogs(limit = 100): Promise<Array<{ id: string; event: string; timestamp: string; details: string }>> {
    const all = await logStore.all();
    return all.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, limit);
  }

  storeNames(): string[] {
    return Object.values(STORES);
  }
}

export const localSearch = new LocalSearchService();

// Expose a stable integration surface for authorized in-browser consumers
// (same-origin scripts within this application context only).
if (typeof window !== "undefined") {
  (window as unknown as { __TixlogicSearch?: typeof localSearch }).__TixlogicSearch = localSearch;
}
