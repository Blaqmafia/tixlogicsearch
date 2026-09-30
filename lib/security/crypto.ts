/**
 * Cryptographic helpers. Web Crypto based (browser + Node 20).
 * - SHA-256 hashing (content hashes, token hashes, query cache keys)
 * - PBKDF2 password hashing with per-user salt
 * - Constant-time comparison
 * NOTE: server session tokens are hashed with HMAC-SHA256 using AUTH_SECRET.
 */

const enc = new TextEncoder();

function getCrypto(): Crypto {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Web Crypto API is unavailable in this environment");
  }
  return globalThis.crypto;
}

export function randomId(prefix = ""): string {
  const bytes = new Uint8Array(16);
  getCrypto().getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}_${hex}` : hex;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await getCrypto().subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Content hash over normalized text so trivial whitespace changes don't create duplicates. */
export async function contentHash(text: string): Promise<string> {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return sha256Hex(normalized);
}

const PBKDF2_ITERATIONS = 120_000;

function bufToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBuf(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Hash a password → "pbkdf2$<iterations>$<saltB64>$<hashB64>" */
export async function hashPassword(password: string): Promise<string> {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bufToB64url(salt)}$${bufToB64url(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const crypto = getCrypto();
    const salt = b64urlToBuf(saltB64);
    const key = await crypto.subtle.importKey("raw", enc.encode(password) as unknown as BufferSource, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" }, key, 256);
    const candidate = bufToB64url(bits);
    return timingSafeEqual(candidate, hashB64);
  } catch {
    return false;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 → hex. Used to hash bearer tokens and sign sessions. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const crypto = getCrypto();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a high-entropy API token: tls_live_<40 hex>. */
export function generateApiToken(): string {
  const bytes = getCrypto().getRandomValues(new Uint8Array(20));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `tls_live_${hex}`;
}
