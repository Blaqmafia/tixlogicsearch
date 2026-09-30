/**
 * Server-side in-memory stores (process lifetime ONLY — explicitly NOT a
 * persistence layer). TixlogicSearch persists search data exclusively in the
 * browser's IndexedDB. These maps hold:
 *   - registered accounts & sessions (single-process, lost on restart)
 *   - integration credential records mirrored from the client for API auth
 *   - rate-limit buckets and usage counters
 * This is documented honestly in README under "Authentication model".
 */

import { hmacSha256Hex, randomId } from "@/lib/security/crypto";
import type { IntegrationPermission, IntegrationRecord, Role } from "@/types";

/* ------------------------------- accounts ------------------------------- */

export interface StoredAccount {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  status: "active" | "disabled";
  createdAt: number;
}

export interface StoredSession {
  sessionId: string;
  userId: string;
  username: string;
  role: Role;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

const accounts = new Map<string, StoredAccount>(); // key: lowercase username
const sessions = new Map<string, StoredSession>(); // key: sessionId
const loginAttempts = new Map<string, { count: number; firstAt: number }>();

export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_SECRET is not configured (min 16 chars). Set it in .env.local before using authentication.");
  }
  return secret;
}

export function sessionMaxAgeMs(): number {
  const raw = parseInt(process.env.SESSION_MAX_AGE ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000 * 60 * 60 * 8; // default 8h
}

export async function createAccount(username: string, passwordHash: string, role: Role): Promise<StoredAccount> {
  const key = username.toLowerCase();
  if (accounts.has(key)) throw new Error("EXISTS");
  const acct: StoredAccount = {
    id: randomId("usr"),
    username,
    passwordHash,
    role,
    status: "active",
    createdAt: Date.now(),
  };
  accounts.set(key, acct);
  return acct;
}

export function findAccount(username: string): StoredAccount | undefined {
  return accounts.get(username.toLowerCase());
}

export function accountCount(): number {
  return accounts.size;
}

export async function createSession(acct: StoredAccount): Promise<StoredSession> {
  const now = Date.now();
  const session: StoredSession = {
    sessionId: randomId("ses"),
    userId: acct.id,
    username: acct.username,
    role: acct.role,
    issuedAt: now,
    expiresAt: now + sessionMaxAgeMs(),
    revoked: false,
  };
  sessions.set(session.sessionId, session);
  return session;
}

/** Session cookie value: "<sessionId>.<hmac(secret, sessionId)>" */
export async function signSession(sessionId: string): Promise<string> {
  const sig = await hmacSha256Hex(getAuthSecret(), sessionId);
  return `${sessionId}.${sig}`;
}

export async function verifySignedSession(cookieValue: string): Promise<StoredSession | null> {
  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return null;
  const sessionId = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  const expected = await hmacSha256Hex(getAuthSecret(), sessionId);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const session = sessions.get(sessionId);
  if (!session || session.revoked || session.expiresAt < Date.now()) return null;
  return session;
}

export function revokeSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) s.revoked = true;
}

export function activeSessionCount(): number {
  const now = Date.now();
  let n = 0;
  for (const s of sessions.values()) if (!s.revoked && s.expiresAt > now) n++;
  return n;
}

/* ---------------------------- brute force lock --------------------------- */

export interface LockResult {
  locked: boolean;
  retryAfterSeconds?: number;
}

export function checkLoginLock(key: string, max = 5, windowMs = 15 * 60 * 1000): LockResult {
  const rec = loginAttempts.get(key);
  if (!rec) return { locked: false };
  if (Date.now() - rec.firstAt > windowMs) {
    loginAttempts.delete(key);
    return { locked: false };
  }
  if (rec.count >= max) {
    return { locked: true, retryAfterSeconds: Math.ceil((windowMs - (Date.now() - rec.firstAt)) / 1000) };
  }
  return { locked: false };
}

export function recordLoginFailure(key: string): void {
  const rec = loginAttempts.get(key);
  if (!rec) loginAttempts.set(key, { count: 1, firstAt: Date.now() });
  else rec.count += 1;
}

export function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

/* --------------------- integration credential records -------------------- */

export interface ServerIntegration {
  id: string;
  name: string;
  permissions: IntegrationPermission[];
  tokenPrefix: string;
  tokenHash: string; // sha256 hex of full token
  status: "active" | "revoked";
  rateLimitPerMinute: number;
  createdAt: number;
  lastRotatedAt?: number;
}

const integrations = new Map<string, ServerIntegration>(); // key: tokenHash

export function registerIntegration(rec: ServerIntegration): void {
  integrations.set(rec.tokenHash, rec);
}

export function updateIntegration(rec: ServerIntegration, oldTokenHash: string): void {
  integrations.delete(oldTokenHash);
  integrations.set(rec.tokenHash, rec);
}

export function removeIntegration(tokenHash: string): void {
  integrations.delete(tokenHash);
}

export function findIntegrationByTokenHash(tokenHash: string): ServerIntegration | undefined {
  return integrations.get(tokenHash);
}

export function integrationCount(): number {
  return integrations.size;
}

export function syncIntegrations(records: Array<Omit<ServerIntegration, "createdAt"> & { createdAt: number }>): number {
  let imported = 0;
  for (const r of records) {
    if (!integrations.has(r.tokenHash)) {
      integrations.set(r.tokenHash, { ...r });
      imported++;
    }
  }
  return imported;
}

/* ------------------------------ rate limiting ---------------------------- */

interface Bucket {
  hits: number[];
}
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
  limit: number;
}

export function rateLimit(key: string, limitPerMinute: number): RateLimitResult {
  const now = Date.now();
  const windowMs = 60_000;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limitPerMinute) {
    const retry = Math.ceil((windowMs - (now - bucket.hits[0])) / 1000);
    return { allowed: false, remaining: 0, retryAfterSeconds: retry, limit: limitPerMinute };
  }
  bucket.hits.push(now);
  return { allowed: true, remaining: limitPerMinute - bucket.hits.length, limit: limitPerMinute };
}

export function defaultApiRateLimit(): number {
  const raw = parseInt(process.env.API_RATE_LIMIT ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

/* -------------------------------- usage --------------------------------- */

export interface UsageEvent {
  endpoint: string;
  method: string;
  status: number;
  at: number;
  integrationId?: string;
}

const usageEvents: UsageEvent[] = [];
const MAX_USAGE_EVENTS = 5000;

export function recordUsage(event: UsageEvent): void {
  usageEvents.push(event);
  if (usageEvents.length > MAX_USAGE_EVENTS) usageEvents.splice(0, usageEvents.length - MAX_USAGE_EVENTS);
}

export function getUsageSummary(): {
  totalRequests: number;
  byEndpoint: Record<string, number>;
  byStatusClass: Record<string, number>;
  window: string;
  note: string;
} {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = usageEvents.filter((e) => e.at >= cutoff);
  const byEndpoint: Record<string, number> = {};
  const byStatusClass: Record<string, number> = {};
  for (const e of recent) {
    byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] || 0) + 1;
    const cls = `${Math.floor(e.status / 100)}xx`;
    byStatusClass[cls] = (byStatusClass[cls] || 0) + 1;
  }
  return {
    totalRequests: recent.length,
    byEndpoint,
    byStatusClass,
    window: "last-24h",
    note: "Process-local transient counters. Reset when the server process restarts. Browser-local usage is stored separately in IndexedDB.",
  };
}
