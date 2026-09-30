/**
 * Custom inverted index built on a plain Map. Persistence of the entries is
 * handled by the IndexedDB layer (client) — this module is pure logic so it
 * can be unit-tested and reused anywhere.
 */

import { tokenize, stemWord } from "@/lib/search/tokenizer";

export interface IndexDocumentStats {
  id: string;
  length: number; // total token count in the indexed body text
}

export interface PostingEntry {
  documentIds: string[];
  termFrequencies: Record<string, number>;
  positions: Record<string, number[]>;
}

export class InvertedIndex {
  /** term -> posting list */
  private postings = new Map<string, PostingEntry>();
  /** docId -> stats */
  private docs = new Map<string, IndexDocumentStats>();

  get documentCount(): number {
    return this.docs.size;
  }

  get termCount(): number {
    return this.postings.size;
  }

  get totalTokens(): number {
    let sum = 0;
    for (const d of this.docs.values()) sum += d.length;
    return sum;
  }

  static build(documents: Array<{ id: string; title: string; content: string; headings?: string[]; keywords?: string[] }>, stemming = false): InvertedIndex {
    const index = new InvertedIndex();
    for (const doc of documents) {
      index.addDocument(doc.id, InvertedIndex.documentText(doc), stemming);
    }
    return index;
  }

  static documentText(doc: { title: string; content: string; headings?: string[]; keywords?: string[] }): string {
    return [doc.title, (doc.headings || []).join(" "), (doc.keywords || []).join(" "), doc.content]
      .filter(Boolean)
      .join(" \u0001 ");
  }

  /** Tokenize + optionally stem a text into index terms. */
  static terms(text: string, stemming = false): string[] {
    const tokens = tokenize(text, { removeStopWords: false });
    return stemming ? tokens.map(stemWord) : tokens;
  }

  addDocument(id: string, text: string, stemming = false): void {
    this.removeDocument(id);
    const tokens = InvertedIndex.terms(text, stemming);
    this.docs.set(id, { id, length: tokens.length });
    const tf: Record<string, number> = {};
    const pos: Record<string, number[]> = {};
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      tf[t] = (tf[t] || 0) + 1;
      (pos[t] ||= []).push(i);
    }
    for (const term of Object.keys(tf)) {
      let entry = this.postings.get(term);
      if (!entry) {
        entry = { documentIds: [], termFrequencies: {}, positions: {} };
        this.postings.set(term, entry);
      }
      entry.documentIds.push(id);
      entry.termFrequencies[id] = tf[term];
      entry.positions[id] = pos[term].slice(0, 256); // bounded positions
    }
  }

  updateDocument(id: string, text: string, stemming = false): void {
    this.addDocument(id, text, stemming); // remove + re-add keeps consistency
  }

  removeDocument(id: string): void {
    if (!this.docs.has(id)) return;
    this.docs.delete(id);
    const emptyTerms: string[] = [];
    for (const [term, entry] of this.postings.entries()) {
      const idx = entry.documentIds.indexOf(id);
      if (idx !== -1) {
        entry.documentIds.splice(idx, 1);
        delete entry.termFrequencies[id];
        delete entry.positions[id];
        if (entry.documentIds.length === 0) emptyTerms.push(term);
      }
    }
    for (const t of emptyTerms) this.postings.delete(t);
  }

  getPosting(term: string): PostingEntry | undefined {
    return this.postings.get(term);
  }

  getDocumentStats(id: string): IndexDocumentStats | undefined {
    return this.docs.get(id);
  }

  /** Documents containing ALL given terms (AND semantics). */
  intersect(terms: string[]): string[] {
    if (terms.length === 0) return [];
    let acc: Set<string> | null = null;
    for (const t of terms) {
      const p = this.postings.get(t);
      if (!p) return [];
      const set = new Set(p.documentIds);
      acc = acc === null ? set : new Set<string>([...acc].filter((x) => set.has(x)));
      if (acc.size === 0) return [];
    }
    return acc ? [...acc] : [];
  }

  /** Documents containing ANY given term (OR semantics). */
  union(terms: string[]): string[] {
    const set = new Set<string>();
    for (const t of terms) {
      const p = this.postings.get(t);
      if (p) for (const id of p.documentIds) set.add(id);
    }
    return [...set];
  }

  allDocumentIds(): string[] {
    return [...this.docs.keys()];
  }

  /** Serialize entries for persistence. */
  toEntries(): Array<{ term: string; documentIds: string[]; termFrequencies: Record<string, number>; positions: Record<string, number[]> }> {
    return [...this.postings.entries()].map(([term, e]) => ({
      term,
      documentIds: e.documentIds,
      termFrequencies: e.termFrequencies,
      positions: e.positions,
    }));
  }

  /** Load persisted entries (used when hydrating from IndexedDB). */
  loadEntries(
    entries: Array<{ term: string; documentIds: string[]; termFrequencies: Record<string, number>; positions: Record<string, number[]> }>,
    documents: IndexDocumentStats[]
  ): void {
    this.postings.clear();
    this.docs.clear();
    for (const e of entries) {
      this.postings.set(e.term, {
        documentIds: [...e.documentIds],
        termFrequencies: { ...e.termFrequencies },
        positions: { ...e.positions },
      });
    }
    for (const d of documents) this.docs.set(d.id, { ...d });
  }

  averageDocumentLength(): number {
    if (this.docs.size === 0) return 0;
    return this.totalTokens / this.docs.size;
  }
}
