/**
 * Client services: local web retrieval (via the server crawl API), integration
 * credential management (IndexedDB) and usage logging (IndexedDB).
 */

"use client";

import { randomId, sha256Hex } from "@/lib/security/crypto";
import { integrationStore, logStore, STORES } from "@/lib/storage/idb";
import type { CrawlJobRecord, CrawlResponse, IntegrationPermission, IntegrationRecord } from "@/types";
import { DEFAULT_CRAWL_CONFIG } from "@/types";

/* ------------------------------ fetch helper ----------------------------- */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`API returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: string } })?.error;
    throw new Error(err?.message ?? `Request failed with HTTP ${res.status}`);
  }
  return body as T;
}

/* ---------------------------- crawl service ------------------------------ */

export interface RetrieveResult {
  documents: number;
  duplicates: number;
  failed: number;
  errors: string[];
  job: CrawlJobRecord;
  raw: CrawlResponse;
}

class WebRetrieveService {
  private activeJobs = new Map<string, { cancelled: boolean }>();

  /**
   * Ask the server to securely retrieve pages, then store extracted documents
   * into browser-local IndexedDB and update the inverted index.
   */
  async retrieveUrl(
    url: string,
    config: Partial<typeof DEFAULT_CRAWL_CONFIG> = {},
    onProgress?: (job: CrawlJobRecord) => void
  ): Promise<RetrieveResult> {
    const { localSearch } = await import("@/services/local-search-service");
    const jobId = randomId("job");
    const job: CrawlJobRecord = {
      id: jobId,
      url,
      status: "running",
      maxPages: config.maxPages ?? DEFAULT_CRAWL_CONFIG.maxPages,
      depth: config.depth ?? DEFAULT_CRAWL_CONFIG.depth,
      sameDomainOnly: config.sameDomainOnly ?? true,
      pagesRetrieved: 0,
      pagesFailed: 0,
      documentsStored: 0,
      duplicatesSkipped: 0,
      errors: [],
      startedAt: new Date().toISOString(),
    };
    this.activeJobs.set(jobId, { cancelled: false });
    await this.saveJob(job);
    onProgress?.(job);

    try {
      const raw = await api<CrawlResponse>("/api/v1/crawl", {
        method: "POST",
        body: JSON.stringify({ url, config }),
      });
      if (this.activeJobs.get(jobId)?.cancelled) {
        job.status = "cancelled";
        job.errors.push("Cancelled before results were stored");
      } else {
        // Persist retrieved documents locally.
        for (const page of raw.pageResults) {
          if (page.status === "stored" && page.documentPayload) {
            const p = page.documentPayload as {
              url: string; canonicalUrl: string; title: string; description: string;
              content: string; headings: string[]; keywords: string[]; language: string; source: string;
            };
            const res = await localSearch.addDocument(p);
            if ("duplicateOf" in res && res.duplicateOf) job.duplicatesSkipped++;
            else job.documentsStored++;
          } else if (page.status === "duplicate") job.duplicatesSkipped++;
          else if (page.status === "failed") job.pagesFailed++;
          job.pagesRetrieved++;
        }
        job.errors = raw.errors.slice(0, 20);
        job.status = raw.status === "completed" ? "completed" : raw.status === "partial" ? "completed" : "failed";
      }
      job.finishedAt = new Date().toISOString();
      await this.saveJob(job);
      onProgress?.(job);
      await this.logEvent("crawl.completed", `${url} → ${job.documentsStored} stored, ${job.pagesFailed} failed`);
      return { documents: job.documentsStored, duplicates: job.duplicatesSkipped, failed: job.pagesFailed, errors: job.errors, job, raw };
    } catch (e) {
      job.status = "failed";
      job.errors = [e instanceof Error ? e.message : String(e)];
      job.finishedAt = new Date().toISOString();
      await this.saveJob(job);
      onProgress?.(job);
      await this.logEvent("crawl.failed", `${url}: ${job.errors[0]}`);
      throw e;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  cancelJob(jobId: string): boolean {
    const handle = this.activeJobs.get(jobId);
    if (!handle) return false;
    handle.cancelled = true;
    return true;
  }

  async saveJob(job: CrawlJobRecord): Promise<void> {
    const { crawlStore } = await import("@/lib/storage/idb");
    await crawlStore.put(job);
    // keep bounded
    const all = await crawlStore.all();
    if (all.length > 200) {
      const sorted = all.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      for (const old of sorted.slice(200)) await crawlStore.remove(old.id);
    }
  }

  async listJobs(limit = 30): Promise<CrawlJobRecord[]> {
    const { crawlStore } = await import("@/lib/storage/idb");
    const all = await crawlStore.all();
    return all.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, limit);
  }

  async clearJobs(): Promise<void> {
    const { crawlStore } = await import("@/lib/storage/idb");
    await crawlStore.clear();
  }

  /* ------------------------------- usage -------------------------------- */

  async logEvent(event: string, details: string): Promise<void> {
    try {
      await logStore.put({ id: randomId("log"), event, timestamp: new Date().toISOString(), details: details.slice(0, 500) });
    } catch {
      /* non-fatal */
    }
  }

  async usageSummary(limit = 400): Promise<{ searches: number; crawls: number; aiRequests: number; apiCalls: number; recent: Array<{ event: string; details: string; timestamp: string }> }> {
    const all = await logStore.all();
    const recent = all.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, limit);
    let searches = 0;
    let crawls = 0;
    let aiRequests = 0;
    let apiCalls = 0;
    for (const l of all) {
      if (l.event.startsWith("search.")) searches++;
      else if (l.event.startsWith("crawl.")) crawls++;
      else if (l.event.startsWith("ai.")) aiRequests++;
      else if (l.event.startsWith("api.")) apiCalls++;
    }
    return {
      searches,
      crawls,
      aiRequests,
      apiCalls,
      recent: recent.map((r) => ({ event: r.event, details: r.details, timestamp: r.timestamp })),
    };
  }

  /* --------------------------- integrations ----------------------------- */

  /**
   * Create an integration credential. Only the SHA-256 hash of the token is
   * persisted in IndexedDB — the plaintext token is shown once and never stored.
   */
  async createIntegration(
    name: string,
    permissions: IntegrationPermission[],
    rateLimitPerMinute = 60
  ): Promise<{ record: IntegrationRecord; token: string }> {
    const { generateApiToken } = await import("@/lib/security/crypto");
    const token = generateApiToken();
    const tokenHash = await sha256Hex(token);
    const record: IntegrationRecord = {
      id: randomId("int"),
      name,
      permissions,
      createdAt: new Date().toISOString(),
      status: "active",
      rateLimitPerMinute,
      tokenPrefix: token.slice(0, 12),
      tokenHash,
    };
    await integrationStore.put(record);
    await this.logEvent("integration.created", `Created integration "${name}"`);
    return { record, token };
  }

  async listIntegrations(): Promise<IntegrationRecord[]> {
    const all = await integrationStore.all();
    return all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async revokeIntegration(id: string): Promise<IntegrationRecord | null> {
    const rec = await integrationStore.all().then((all) => all.find((r) => r.id === id));
    if (!rec) return null;
    const updated = { ...rec, status: "revoked" as const };
    await integrationStore.put(updated);
    await this.logEvent("integration.revoked", `Revoked integration "${rec.name}"`);
    return updated;
  }

  async rotateIntegration(id: string): Promise<{ record: IntegrationRecord; token: string } | null> {
    const rec = await integrationStore.all().then((all) => all.find((r) => r.id === id));
    if (!rec) return null;
    const { generateApiToken } = await import("@/lib/security/crypto");
    const token = generateApiToken();
    const updated: IntegrationRecord = {
      ...rec,
      tokenHash: await sha256Hex(token),
      tokenPrefix: token.slice(0, 12),
      status: "active",
      lastRotatedAt: new Date().toISOString(),
    };
    await integrationStore.put(updated);
    await this.logEvent("integration.rotated", `Rotated credential for "${rec.name}"`);
    return { record: updated, token };
  }

  async deleteIntegration(id: string): Promise<boolean> {
    const rec = await integrationStore.all().then((all) => all.find((r) => r.id === id));
    if (!rec) return false;
    await integrationStore.remove(id);
    await this.logEvent("integration.deleted", `Deleted integration "${rec.name}"`);
    return true;
  }

  /**
   * Register this browser's integration credentials with the running server so
   * remote Bearer-token auth can validate them (hashes only — no plaintext).
   */
  async syncToIntegrationsEndpoint(): Promise<{ imported: number } | { error: string }> {
    try {
      const records = await integrationStore.all();
      const payload = records
        .filter((r) => r.status === "active")
        .map((r) => ({
          id: r.id,
          name: r.name,
          permissions: r.permissions,
          tokenPrefix: r.tokenPrefix,
          tokenHash: r.tokenHash,
          status: r.status,
          rateLimitPerMinute: r.rateLimitPerMinute,
          createdAt: Date.parse(r.createdAt),
          lastRotatedAt: r.lastRotatedAt ? Date.parse(r.lastRotatedAt) : undefined,
        }));
      const res = await api<{ imported: number }>("/api/v1/integrations/sync", {
        method: "POST",
        body: JSON.stringify({ integrations: payload }),
      });
      return res;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  storeNames(): string[] {
    return Object.values(STORES);
  }
}

export const webRetrieve = new WebRetrieveService();

// CrawlPageResult.documentPayload is declared in @/types; nothing to augment here.
