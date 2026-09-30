/**
 * POST /api/v1/search — versioned search API.
 *
 * Two honest modes:
 *  - corpus mode (default): searches exactly the documents the caller submits.
 *    The server cannot read browser IndexedDB and never pretends to.
 *  - live web mode (`fetchLive: true`, or `source: "web"` with an empty
 *    corpus): securely retrieves real public web pages (optionally restricted
 *    to a `site`) and ranks them with the same BM25/TF-IDF engine.
 *
 * GET /api/v1/search?q=...&site=... — convenience GET wrapper for the
 * live web mode so integrations can use simple links/cURL.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { optionsResponse } from "@/lib/security/api-helpers";
import { applyIpRateLimit, fail, makeCtx, parseBody } from "@/lib/api/route-helpers";
import { remoteSearchRequestSchema } from "@/lib/validation/search-request";
import { serverSearchBundle, liveWebSearch } from "@/lib/search/server-search-service";
import { serializeSearchResponse } from "@/lib/validation/serializers";
import type { SearchResponse } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  query: z.string().trim().min(1, "query is required").max(512),
  source: z.enum(["web", "local", "corpus"]).optional().default("corpus"),
  corpus: remoteSearchRequestSchema.shape.corpus.optional().default([]),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  domain: z.string().trim().max(253).optional(),
  algorithm: z.enum(["bm25", "tfidf"]).optional(),
  sort: z.enum(["relevance", "date", "title"]).optional().default("relevance"),
  fetchLive: z.boolean().optional().default(false),
  site: z.string().trim().max(253).optional(),
  maxPages: z.coerce.number().int().min(1).max(20).optional().default(8),
  depth: z.coerce.number().int().min(0).max(2).optional().default(1),
});

export function OPTIONS(req: NextRequest) {
  return optionsResponse(req);
}

export async function POST(req: NextRequest) {
  const ctx = makeCtx(req);
  const rl = applyIpRateLimit(ctx, req);
  if (rl) return rl;

  const parsed = await parseBody(bodySchema, req, ctx);
  if (!parsed.ok) return parsed.response;
  const data = parsed.data as z.infer<typeof bodySchema>;

  try {
    if (data.fetchLive || (data.source === "web" && data.corpus.length === 0)) {
      const result = await liveWebSearch(data.query, {
        site: data.site,
        maxPages: data.maxPages,
        depth: data.depth,
        domain: data.domain,
        limit: data.limit,
        page: data.page,
        sort: data.sort,
        algorithm: data.algorithm,
      });
      if ("error" in result) {
        return fail(502, "RETRIEVAL_FAILED", result.error, ctx);
      }
      const resp: SearchResponse = {
        ...result.response,
        scope: "live-web",
        tookMs: result.tookMsTotal,
      };
      const serialized = serializeSearchResponse(resp, ctx.format);
      return new Response(serialized.body, {
        status: 200,
        headers: {
          "Content-Type": serialized.contentType,
          "X-Request-Id": ctx.rid,
        },
      });
    }

    const bundle = serverSearchBundle(data.query, data.corpus, {
      domain: data.domain,
      limit: data.limit,
      page: data.page,
      sort: data.sort,
      algorithm: data.algorithm,
    });
    const resp: SearchResponse = { ...bundle.response, scope: "submitted-corpus" };
    const serialized = serializeSearchResponse(resp, ctx.format);
    return new Response(serialized.body, {
      status: 200,
      headers: {
        "Content-Type": serialized.contentType,
        "X-Request-Id": ctx.rid,
      },
    });
  } catch (e) {
    return fail(500, "INTERNAL_ERROR", "Search failed unexpectedly.", ctx, process.env.NODE_ENV === "development" ? String(e) : undefined);
  }
}

export async function GET(req: NextRequest) {
  const ctx = makeCtx(req);
  const rl = applyIpRateLimit(ctx, req);
  if (rl) return rl;

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (!q || q.length > 512) {
    return fail(422, "VALIDATION_FAILED", "Query `q` is required (1–512 characters).", ctx);
  }
  const site = sp.get("site") ?? undefined;
  const limit = Math.min(100, Math.max(1, parseInt(sp.get("limit") ?? "10", 10) || 10));
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);

  try {
    const result = await liveWebSearch(q, { site, limit, page, maxPages: 8, depth: site ? 1 : 0 });
    if ("error" in result) return fail(502, "RETRIEVAL_FAILED", result.error, ctx);
    const resp: SearchResponse = { ...result.response, scope: "live-web", tookMs: result.tookMsTotal };
    const serialized = serializeSearchResponse(resp, ctx.format);
    return new Response(serialized.body, {
      status: 200,
      headers: { "Content-Type": serialized.contentType, "X-Request-Id": ctx.rid },
    });
  } catch (e) {
    return fail(500, "INTERNAL_ERROR", "Search failed unexpectedly.", ctx, process.env.NODE_ENV === "development" ? String(e) : undefined);
  }
}
