/**
 * Zod schemas shared by API route handlers (server-side validation of every
 * request payload).
 */

import { z } from "zod";
import { ALL_PERMISSIONS } from "@/types";

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_:.-]+$/, "id contains invalid characters");

export const urlSchema = z
  .string()
  .min(8)
  .max(2048)
  .refine((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be a valid http(s) URL");

export const shortText = (max: number) => z.string().trim().max(max);

export const searchRequestSchema = z.object({
  query: z.string().min(1, "query is required").max(512, "query too long"),
  source: z.enum(["local", "web", "ai"]).optional().default("local"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  format: z.enum(["json", "xml", "csv", "markdown", "text", "html", "ndjson"]).optional().default("json"),
  domain: z.string().max(253).optional(),
  algorithm: z.enum(["bm25", "tfidf"]).optional(),
  sort: z.enum(["relevance", "date", "title"]).optional(),
});
export type SearchRequestBody = z.infer<typeof searchRequestSchema>;

export const aiSearchRequestSchema = z.object({
  query: z.string().min(1).max(512),
  mode: z.enum(["auto", "website", "learning"]).optional().default("auto"),
  site: z.string().max(253).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});
export type AiSearchRequestBody = z.infer<typeof aiSearchRequestSchema>;

export const websiteSearchRequestSchema = z.object({
  query: z.string().min(1).max(512),
  site: z.string().min(1).max(253, "site too long"),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  crawlIfEmpty: z.boolean().optional().default(true),
});
export type WebsiteSearchRequestBody = z.infer<typeof websiteSearchRequestSchema>;

export const documentCreateSchema = z.object({
  id: idSchema.optional(),
  url: urlSchema,
  canonicalUrl: urlSchema.optional(),
  title: shortText(500).min(1),
  description: shortText(2000).optional().default(""),
  content: z.string().max(2_000_000).optional().default(""),
  headings: z.array(shortText(500)).max(200).optional().default([]),
  keywords: z.array(shortText(100)).max(100).optional().default([]),
  source: shortText(253).optional(),
  language: shortText(35).optional().default("en"),
});
export type DocumentCreateBody = z.infer<typeof documentCreateSchema>;

export const documentUpdateSchema = documentCreateSchema.partial().extend({
  content: z.string().max(2_000_000).optional(),
});

export const documentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  q: z.string().max(253).optional(),
});

export const crawlConfigSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(50).optional().default(10),
  depth: z.coerce.number().int().min(0).max(3).optional().default(1),
  sameDomainOnly: z.boolean().optional().default(true),
  timeoutMs: z.coerce.number().int().min(1000).max(30000).optional().default(15000),
  delayMs: z.coerce.number().int().min(0).max(10000).optional().default(500),
});

export const crawlRequestSchema = z.object({
  url: urlSchema,
  config: crawlConfigSchema.optional(),
  store: z
    .object({
      documents: z.array(
        z.object({
          url: urlSchema,
          canonicalUrl: urlSchema.optional(),
          title: shortText(500).min(1),
          description: shortText(2000).optional().default(""),
          content: z.string().max(2_000_000).optional().default(""),
          headings: z.array(shortText(500)).max(200).optional().default([]),
          keywords: z.array(shortText(100)).max(100).optional().default([]),
          language: shortText(35).optional().default("en"),
        })
      ).max(50).optional().default([]),
    })
    .optional(),
});
export type CrawlRequestBody = z.infer<typeof crawlRequestSchema>;

export const integrationCreateSchema = z.object({
  name: shortText(120).min(2, "name too short"),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).min(1).max(ALL_PERMISSIONS.length),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(1000).optional().default(60),
});

export const integrationUpdateSchema = z.object({
  name: shortText(120).min(2).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).min(1).optional(),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(1000).optional(),
  status: z.enum(["active", "revoked"]).optional(),
});

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "username must be at least 3 characters")
    .max(32)
    .regex(/^[A-Za-z0-9_.@-]+$/, "username may contain letters, numbers, . _ @ - only"),
  password: z
    .string()
    .min(10, "password must be at least 10 characters")
    .max(200)
    .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "password must mix letters and digits"),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export function formatZodError(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
