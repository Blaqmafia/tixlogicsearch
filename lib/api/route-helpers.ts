/**
 * Shared route-handler plumbing for every /api/v1 endpoint:
 * request id, rate limiting, body reading + Zod validation, format
 * negotiation and consistent (multi-format) success/error responses.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import type { OutputFormat, SearchResponse } from "@/types";
import {
  corsHeaders,
  ipOf,
  requestId,
  readJsonBody,
  securityHeaders,
  trackUsage,
} from "@/lib/security/api-helpers";
import { defaultApiRateLimit, rateLimit } from "@/lib/security/server-store";
import { formatZodError } from "@/lib/validation/schemas";
import {
  isOutputFormat,
  negotiateFormat,
  serializeError,
  serializeSearchResponse,
} from "@/lib/validation/serializers";

export interface Ctx {
  rid: string;
  req: NextRequest;
  format: OutputFormat;
}

export function makeCtx(req: NextRequest): Ctx {
  const explicitParam = req.nextUrl.searchParams.get("format");
  const explicit = isOutputFormat(explicitParam) ? explicitParam : undefined;
  return {
    rid: requestId(),
    req,
    format: negotiateFormat(req.headers.get("accept"), explicit),
  };
}

/** Per-IP rate limit applied to unauthenticated endpoints. Returns an error response when exceeded. */
export function applyIpRateLimit(ctx: Ctx, req: NextRequest): NextResponse | null {
  const rl = rateLimit(`ip:${ipOf(req)}`, defaultApiRateLimit());
  if (!rl.allowed) {
    return fail(429, "RATE_LIMITED", "Rate limit exceeded. Slow down.", ctx, undefined, {
      "Retry-After": String(rl.retryAfterSeconds ?? 60),
    });
  }
  return null;
}

export type BodyResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

export async function parseBody<T>(
  schema: z.ZodType<T>,
  req: NextRequest,
  ctx: Ctx
): Promise<BodyResult<T>> {
  const raw = await readJsonBody<unknown>(req, ctx.rid);
  if (!raw.ok) return { ok: false, response: raw.response };
  const parsed = schema.safeParse(raw.data);
  if (!parsed.success) {
    return {
      ok: false,
      response: fail(422, "VALIDATION_FAILED", "Request body failed validation.", ctx, formatZodError(parsed.error)),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Standard success JSON response with security headers, CORS and request id. */
export function ok(ctx: Ctx, data: unknown, status = 200, extra?: Record<string, string>): NextResponse {
  trackUsage(ctx.req, status);
  return new NextResponse(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-Id": ctx.rid,
      ...securityHeaders(),
      ...corsHeaders(ctx.req),
      ...(extra ?? {}),
    },
  });
}

/** Standard error response, serialized in the negotiated output format so errors stay consistent everywhere. */
export function fail(
  status: number,
  code: string,
  message: string,
  ctx: Ctx,
  details?: unknown,
  extraHeaders?: Record<string, string>
): NextResponse {
  trackUsage(ctx.req, status);
  const errorBody = { error: { code, message, requestId: ctx.rid, ...(details !== undefined ? { details } : {}) } };
  const serialized = serializeError(errorBody, ctx.format);
  return new NextResponse(serialized.body, {
    status,
    headers: {
      "Content-Type": serialized.contentType,
      "X-Request-Id": ctx.rid,
      ...securityHeaders(),
      ...corsHeaders(ctx.req),
      ...(extraHeaders ?? {}),
    },
  });
}

/** Respond to a search response in the negotiated format (json/xml/csv/markdown/text/html/ndjson). */
export function respondSearch(ctx: Ctx, response: SearchResponse): NextResponse {
  const serialized = serializeSearchResponse(response, ctx.format);
  trackUsage(ctx.req, 200);
  return new NextResponse(serialized.body, {
    status: 200,
    headers: {
      "Content-Type": serialized.contentType,
      "X-Request-Id": ctx.rid,
      ...securityHeaders(),
      ...corsHeaders(ctx.req),
    },
  });
}
