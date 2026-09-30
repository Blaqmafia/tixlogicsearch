/**
 * Server-side API helpers: request ids, error envelope, CORS allowlisting,
 * security headers, bearer-token authentication and authorization checks.
 */

import { NextRequest, NextResponse } from "next/server";
import { sha256Hex, timingSafeEqual } from "@/lib/security/crypto";
import {
  defaultApiRateLimit,
  findIntegrationByTokenHash,
  rateLimit,
  recordUsage,
  verifySignedSession,
  type ServerIntegration,
} from "@/lib/security/server-store";
import type { ApiErrorBody, Role } from "@/types";
import { randomId } from "@/lib/security/crypto";

export const SESSION_COOKIE = "tls_session";

export function requestId(): string {
  return randomId("req");
}

export function securityHeaders(init?: HeadersInit): HeadersInit {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...init,
  };
}

export function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headers: Record<string, string> = {};
  if (origin && (allowed.includes(origin) || allowed.includes("*"))) {
    headers["Access-Control-Allow-Origin"] = allowed.includes("*") ? "*" : origin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization,X-Requested-With";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  rid: string,
  details?: unknown,
  extraHeaders?: Record<string, string>
): NextResponse {
  const body: ApiErrorBody = { error: { code, message, requestId: rid, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, {
    status,
    headers: { "X-Request-Id": rid, ...securityHeaders(), ...extraHeaders },
  });
}

export function jsonOk(data: unknown, rid: string, extraHeaders?: Record<string, string>, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { "X-Request-Id": rid, ...securityHeaders(), ...extraHeaders },
  });
}

export function optionsResponse(req: NextRequest): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders(req), ...securityHeaders() } });
}

/* --------------------------- request size guard --------------------------- */

export const MAX_BODY_BYTES = 1_000_000; // 1 MB

export async function readJsonBody<T>(req: NextRequest, rid: string): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the 1 MB limit.", rid) };
  }
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return { ok: false, response: jsonError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", rid) };
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: jsonError(400, "UNREADABLE_BODY", "Could not read request body.", rid) };
  }
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the 1 MB limit.", rid) };
  }
  if (raw.trim().length === 0) {
    return { ok: false, response: jsonError(400, "EMPTY_BODY", "Request body is empty.", rid) };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as T };
  } catch {
    return { ok: false, response: jsonError(400, "INVALID_JSON", "Request body is not valid JSON.", rid) };
  }
}

/* ------------------------------ auth context ----------------------------- */

export interface AuthContext {
  integration?: ServerIntegration;
  session?: { username: string; role: Role };
  rid: string;
}

export type AuthResult = { ok: true; ctx: AuthContext } | { ok: false; response: NextResponse };

/**
 * Authenticate a protected API request. Accepts either:
 *   Authorization: Bearer tls_live_<token>   (integration credential)
 *   or a valid signed session cookie         (interactive user)
 */
export async function authenticate(req: NextRequest, rid: string): Promise<AuthResult> {
  const rlKey = `api:${rid.slice(0, 0)}${ipOf(req)}`;
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (!token.startsWith("tls_live_") || token.length > 128) {
      return { ok: false, response: jsonError(401, "INVALID_CREDENTIAL", "Malformed API token.", rid) };
    }
    const tokenHash = await sha256Hex(token);
    const integration = findIntegrationByTokenHash(tokenHash);
    if (!integration) {
      return { ok: false, response: jsonError(401, "UNKNOWN_CREDENTIAL", "API token is not recognized or was revoked.", rid) };
    }
    if (integration.status !== "active") {
      return { ok: false, response: jsonError(403, "CREDENTIAL_REVOKED", "This integration credential has been revoked.", rid) };
    }
    const limit = Math.min(integration.rateLimitPerMinute || defaultApiRateLimit(), 1000);
    const rl = rateLimit(`int:${integration.id}`, limit);
    if (!rl.allowed) {
      return {
        ok: false,
        response: jsonError(429, "RATE_LIMITED", "Per-integration rate limit exceeded.", rid, {
          retryAfterSeconds: rl.retryAfterSeconds,
        }, { "Retry-After": String(rl.retryAfterSeconds ?? 60) }),
      };
    }
    return { ok: true, ctx: { integration, rid } };
  }

  // Session-cookie path (interactive users of this app itself)
  const cookieVal = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookieVal) {
    try {
      const session = await verifySignedSession(cookieVal);
      if (session) {
        const rl = rateLimit(rlKey, defaultApiRateLimit());
        if (!rl.allowed) {
          return { ok: false, response: jsonError(429, "RATE_LIMITED", "Rate limit exceeded.", rid, undefined, { "Retry-After": String(rl.retryAfterSeconds ?? 60) }) };
        }
        return { ok: true, ctx: { session: { username: session.username, role: session.role }, rid } };
      }
    } catch {
      // AUTH_SECRET missing → treat as unauthenticated with clear error below
    }
  }
  return { ok: false, response: jsonError(401, "UNAUTHENTICATED", "Provide a Bearer integration token or a valid session cookie.", rid) };
}

export function requirePermission(ctx: AuthContext, permission: string): NextResponse | null {
  if (!ctx.integration) {
    // Session-based interactive roles are allowed everything their role permits.
    const role = ctx.session?.role;
    if (!role) return jsonError(403, "FORBIDDEN", "Authentication required for this operation.", ctx.rid);
    if (role === "USER" && ["index:manage"].includes(permission)) {
      return jsonError(403, "FORBIDDEN", `Role ${role} may not perform ${permission}.`, ctx.rid);
    }
    return null;
  }
  if (!ctx.integration.permissions.includes(permission as never)) {
    return jsonError(403, "MISSING_SCOPE", `Integration lacks required scope "${permission}".`, ctx.rid);
  }
  return null;
}

export function requireRole(ctx: AuthContext, roles: Role[]): NextResponse | null {
  const role = ctx.session?.role;
  if (!role) return jsonError(403, "FORBIDDEN", "A logged-in user session is required for this operation.", ctx.rid);
  if (!roles.includes(role)) return jsonError(403, "FORBIDDEN", `Requires one of roles: ${roles.join(", ")}.`, ctx.rid);
  return null;
}

export function ipOf(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function trackUsage(req: NextRequest, status: number, ctx?: AuthContext): void {
  const endpoint = new URL(req.url).pathname.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}|\/[a-z]{2,}_\d+/g, "/:id");
  recordUsage({
    endpoint,
    method: req.method,
    status,
    at: Date.now(),
    integrationId: ctx?.integration?.id,
  });
}

/** Validate an id segment defensively (avoid path traversal / huge inputs). */
export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_:.-]{1,64}$/.test(id);
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}
