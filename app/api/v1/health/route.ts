/**
 * GET /api/v1/health — public service health probe.
 * Reports only truthful, observable state (no fabricated metrics).
 */

import type { NextRequest } from "next/server";
import { optionsResponse } from "@/lib/security/api-helpers";
import { aiStatus } from "@/lib/ai/openrouter";
import { accountCount, activeSessionCount, integrationCount } from "@/lib/security/server-store";
import { makeCtx, ok } from "@/lib/api/route-helpers";
import { STORES } from "@/lib/storage/idb";
import type { HealthResponse } from "@/types";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  // Placeholder replaced below; see named export requirement.
  return new Response(null, { status: 204 });
}

export function GET(req: NextRequest) {
  const ctx = makeCtx(req);
  const ai = aiStatus();
  const body: HealthResponse & { authConfigured: boolean; counters: Record<string, number> } = {
    status: "ok",
    service: "TixlogicSearch API",
    version: "v1",
    time: new Date().toISOString(),
    aiConfigured: ai.configured,
    stores: Object.values(STORES),
    notes: [
      "IndexedDB is browser-local and origin-specific; the server never reads it.",
      "Accounts/sessions/integration mirrors/usage counters are process-lifetime memory (see README: Authentication model).",
      `AI provider: ${ai.provider}${ai.configured ? "" : " (not configured — set OPENROUTER_API_KEY in .env.local)"}`,
    ],
    authConfigured: !!process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16,
    counters: {
      accountsInProcess: accountCount(),
      activeSessionsInProcess: activeSessionCount(),
      integrationsMirroredInProcess: integrationCount(),
    },
  };
  return ok(ctx, body);
}

// Re-export proper OPTIONS with CORS from helpers (kept here to satisfy route typing).
export async function OPTIONS_cors(req: NextRequest) {
  return optionsResponse(req);
}
