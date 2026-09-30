/**
 * IndexedDB storage layer for TixlogicSearch (client-side only).
 * Database: "TixlogicSearchDB", versioned with explicit migrations.
 */

import type {
  CachedResult,
  CrawlJobRecord,
  InvertedIndexEntry,
  IntegrationRecord,
  LocalLogEntry,
  SavedSearch,
  SearchDocument,
  SearchHistoryItem,
  SettingsEntry,
} from "@/types";

export const DB_NAME = "TixlogicSearchDB";
export const DB_VERSION = 1;

export const STORES = {
  documents: "documents",
  invertedIndex: "invertedIndex",
  searchHistory: "searchHistory",
  cachedResults: "cachedResults",
  savedSearches: "savedSearches",
  integrations: "integrations",
  settings: "settings",
  localLogs: "localLogs",
  crawlJobs: "crawlJobs",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export class StorageUnavailableError extends Error {
  constructor(message = "IndexedDB is unavailable in this environment") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

function hasIDB(): boolean {
  return typeof indexedDB !== "undefined";
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Open (and migrate) the database. Rejects with StorageUnavailableError when absent. */
export function openDatabase(): Promise<IDBDatabase> {
  if (!hasIDB()) return Promise.reject(new StorageUnavailableError());
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion ?? 0;
      // v1 — initial schema
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains(STORES.documents)) {
          const s = db.createObjectStore(STORES.documents, { keyPath: "id" });
          s.createIndex("url", "url", { unique: false });
          s.createIndex("canonicalUrl", "canonicalUrl", { unique: false });
          s.createIndex("contentHash", "contentHash", { unique: false });
          s.createIndex("indexedAt", "indexedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.invertedIndex)) {
          db.createObjectStore(STORES.invertedIndex, { keyPath: "term" });
        }
        if (!db.objectStoreNames.contains(STORES.searchHistory)) {
          const s = db.createObjectStore(STORES.searchHistory, { keyPath: "id" });
          s.createIndex("timestamp", "timestamp", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.cachedResults)) {
          const s = db.createObjectStore(STORES.cachedResults, { keyPath: "id" });
          s.createIndex("queryHash", "queryHash", { unique: false });
          s.createIndex("expiresAt", "expiresAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.savedSearches)) {
          db.createObjectStore(STORES.savedSearches, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORES.integrations)) {
          const s = db.createObjectStore(STORES.integrations, { keyPath: "id" });
          s.createIndex("tokenHash", "tokenHash", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.settings)) {
          db.createObjectStore(STORES.settings, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.localLogs)) {
          const s = db.createObjectStore(STORES.localLogs, { keyPath: "id" });
          s.createIndex("timestamp", "timestamp", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.crawlJobs)) {
          db.createObjectStore(STORES.crawlJobs, { keyPath: "id" });
        }
      }
      // future versions add migrations here: if (oldVersion < 2) { ... }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export function isStorageAvailable(): boolean {
  return hasIDB();
}

type Mode = IDBTransactionMode;

function tx(db: IDBDatabase, store: StoreName | StoreName[], mode: Mode): IDBTransaction {
  return db.transaction(store as string | string[], mode);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("Transaction aborted"));
  });
}

export function getAll<T>(store: StoreName): Promise<T[]> {
  return openDatabase().then(async (db) => reqToPromise<T[]>(tx(db, store, "readonly").objectStore(store).getAll()));
}

export function getById<T>(store: StoreName, key: string | number): Promise<T | undefined> {
  return openDatabase().then(async (db) => reqToPromise<T | undefined>(tx(db, store, "readonly").objectStore(store).get(key)));
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDatabase();
  const t = tx(db, store, "readwrite");
  t.objectStore(store).put(value as never);
  await txDone(t);
}

export async function remove(store: StoreName, key: string | number): Promise<void> {
  const db = await openDatabase();
  const t = tx(db, store, "readwrite");
  t.objectStore(store).delete(key);
  await txDone(t);
}

export async function clearStore(store: StoreName): Promise<void> {
  const db = await openDatabase();
  const t = tx(db, store, "readwrite");
  t.objectStore(store).clear();
  await txDone(t);
}

export async function bulkPut<T>(store: StoreName, values: T[]): Promise<void> {
  const db = await openDatabase();
  const t = tx(db, store, "readwrite");
  const os = t.objectStore(store);
  for (const v of values) os.put(v as never);
  await txDone(t);
}

export async function count(store: StoreName): Promise<number> {
  const db = await openDatabase();
  return reqToPromise(tx(db, store, "readonly").objectStore(store).count());
}

/** Find a document whose indexed field equals value via an index. */
export function getByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  return openDatabase().then(async (db) => {
    const os = tx(db, store, "readonly").objectStore(store);
    return reqToPromise<T[]>(os.index(index).getAll(value));
  });
}

export async function deleteMany(store: StoreName, keys: Array<string | number>): Promise<void> {
  const db = await openDatabase();
  const t = tx(db, store, "readwrite");
  const os = t.objectStore(store);
  for (const k of keys) os.delete(k);
  await txDone(t);
}

/* ------------------------- typed convenience APIs ------------------------- */

export const docStore = {
  all: () => getAll<SearchDocument>(STORES.documents),
  get: (id: string) => getById<SearchDocument>(STORES.documents, id),
  put: (d: SearchDocument) => put(STORES.documents, d),
  remove: (id: string) => remove(STORES.documents, id),
  clear: () => clearStore(STORES.documents),
  count: () => count(STORES.documents),
  byCanonicalUrl: (u: string) => getByIndex<SearchDocument>(STORES.documents, "canonicalUrl", u),
  byContentHash: (h: string) => getByIndex<SearchDocument>(STORES.documents, "contentHash", h),
};

export const indexStore = {
  all: () => getAll<InvertedIndexEntry>(STORES.invertedIndex),
  putMany: (entries: InvertedIndexEntry[]) => bulkPut(STORES.invertedIndex, entries),
  clear: () => clearStore(STORES.invertedIndex),
  count: () => count(STORES.invertedIndex),
};

export const historyStore = {
  all: () => getAll<SearchHistoryItem>(STORES.searchHistory),
  put: (h: SearchHistoryItem) => put(STORES.searchHistory, h),
  remove: (id: string) => remove(STORES.searchHistory, id),
  clear: () => clearStore(STORES.searchHistory),
};

export const cacheStore = {
  all: () => getAll<CachedResult>(STORES.cachedResults),
  put: (c: CachedResult) => put(STORES.cachedResults, c),
  remove: (id: string) => remove(STORES.cachedResults, id),
  clear: () => clearStore(STORES.cachedResults),
};

export const savedStore = {
  all: () => getAll<SavedSearch>(STORES.savedSearches),
  put: (s: SavedSearch) => put(STORES.savedSearches, s),
  remove: (id: string) => remove(STORES.savedSearches, id),
  clear: () => clearStore(STORES.savedSearches),
};

export const integrationStore = {
  all: () => getAll<IntegrationRecord>(STORES.integrations),
  put: (i: IntegrationRecord) => put(STORES.integrations, i),
  remove: (id: string) => remove(STORES.integrations, id),
  clear: () => clearStore(STORES.integrations),
  byTokenHash: (h: string) => getByIndex<IntegrationRecord>(STORES.integrations, "tokenHash", h),
};

export const settingsStore = {
  all: () => getAll<SettingsEntry>(STORES.settings),
  get: (key: string) => getById<SettingsEntry>(STORES.settings, key),
  put: (s: SettingsEntry) => put(STORES.settings, s),
  clear: () => clearStore(STORES.settings),
};

export const logStore = {
  all: () => getAll<LocalLogEntry>(STORES.localLogs),
  put: (l: LocalLogEntry) => put(STORES.localLogs, l),
  clear: () => clearStore(STORES.localLogs),
  count: () => count(STORES.localLogs),
};

export const crawlStore = {
  all: () => getAll<CrawlJobRecord>(STORES.crawlJobs),
  get: (id: string) => getById<CrawlJobRecord>(STORES.crawlJobs, id),
  put: (j: CrawlJobRecord) => put(STORES.crawlJobs, j),
  clear: () => clearStore(STORES.crawlJobs),
};

/* ------------------------------ quota / status ----------------------------- */

export interface StorageStatus {
  available: boolean;
  persisted: boolean;
  usageBytes?: number;
  quotaBytes?: number;
  error?: string;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  if (!hasIDB()) return { available: false, persisted: false, error: "IndexedDB not supported in this environment" };
  try {
    await openDatabase();
    let persisted = false;
    let usageBytes: number | undefined;
    let quotaBytes: number | undefined;
    if (navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted();
    }
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usageBytes = est.usage;
      quotaBytes = est.quota;
    }
    return { available: true, persisted, usageBytes, quotaBytes };
  } catch (e) {
    return { available: false, persisted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function requestPersistence(): Promise<boolean> {
  if (!hasIDB() || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function wipeAllData(): Promise<void> {
  const db = await openDatabase();
  const names = Object.values(STORES) as StoreName[];
  const t = tx(db, names, "readwrite");
  for (const n of names) t.objectStore(n).clear();
  await txDone(t);
}
