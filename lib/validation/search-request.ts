/**
 * Search request schema shared by the remote API and client-side callers.
 * `corpus` is REQUIRED for server-side search: the server cannot (and does
 * not pretend to) read browser IndexedDB, so it only searches what the
 * caller submits. See README → "Local vs remote search".
 */

import { z } from "zod";
import { shortText, urlSchema } from "@/lib/validation/schemas";

export const corpusDocumentSchema = z.object({
  id: shortText(64).optional(),
  url: urlSchema,
  canonicalUrl: urlSchema.optional(),
  title: shortText(500).min(1),
  description: shortText(2000).optional(),
  content: z.string().max(200_000).optional(),
  headings: z.array(shortText(500)).max(200).optional(),
  keywords: z.array(shortText(100)).max(100).optional(),
  source: shortText(253).optional(),
  language: shortText(35).optional(),
  indexedAt: z.string().datetime().optional().or(z.string().max(40)),
  updatedAt: z.string().datetime().optional().or(z.string().max(40)),
});

export const remoteSearchRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(512),
  /** Where the documents come from — informational; server always searches `corpus`. */
  source: z.enum(["web", "local", "corpus"]).optional().default("corpus"),
  corpus: z.array(corpusDocumentSchema).min(1, "corpus must contain at least one document").max(200),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  domain: shortText(253).optional(),
  algorithm: z.enum(["bm25", "tfidf"]).optional(),
  sort: z.enum(["relevance", "date", "title"]).optional().default("relevance"),
  format: z.enum(["json", "xml", "csv", "markdown", "text", "html", "ndjson"]).optional(),
});

export type RemoteSearchRequestBody = z.infer<typeof remoteSearchRequestSchema>;
