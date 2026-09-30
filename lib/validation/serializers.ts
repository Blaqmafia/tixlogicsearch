/**
 * Output serializers: one internal result schema → JSON, XML, CSV, Markdown,
 * plain text, sanitized HTML and NDJSON. All escaping is explicit; no raw
 * untrusted content is ever emitted as executable markup.
 */

import type { OutputFormat, SearchResponse, SearchResult } from "@/types";

export const FORMAT_MIME: Record<OutputFormat, string> = {
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
};

const FORMATS = Object.keys(FORMAT_MIME) as OutputFormat[];

export function isOutputFormat(v: unknown): v is OutputFormat {
  return typeof v === "string" && (FORMATS as string[]).includes(v);
}

/** Simple content negotiation from an Accept header. Defaults to JSON. */
export function negotiateFormat(accept: string | null, explicit?: OutputFormat | null): OutputFormat {
  if (explicit && isOutputFormat(explicit)) return explicit;
  if (!accept) return "json";
  const candidates = accept
    .split(",")
    .map((p) => p.trim().split(";")[0].trim().toLowerCase())
    .filter(Boolean);
  for (const c of candidates) {
    if (c === "application/json" || c === "json") return "json";
    if (c === "application/xml" || c === "text/xml" || c === "xml") return "xml";
    if (c === "text/csv" || c === "csv") return "csv";
    if (c === "text/markdown" || c === "markdown" || c === "text/x-markdown") return "markdown";
    if (c === "text/plain" || c === "txt") return "text";
    if (c === "text/html" || c === "html") return "html";
    if (c === "application/x-ndjson" || c === "ndjson") return "ndjson";
  }
  return "json";
}

/* ------------------------------ escaping ------------------------------- */

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // strip control chars invalid in XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function escapeCsvField(value: string): string {
  let v = value.replace(/[\r\n]+/g, " ");
  if (/[",;]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  // Neutralize spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v;
}

/* ----------------------------- serializers ----------------------------- */

export interface SerializedOutput {
  body: string;
  contentType: string;
}

const RESULT_COLUMNS: Array<{ key: keyof SearchResult | "pagination.page" | "pagination.total"; label: string }> = [
  { key: "id", label: "id" },
  { key: "title", label: "title" },
  { key: "url", label: "url" },
  { key: "canonicalUrl", label: "canonicalUrl" },
  { key: "description", label: "description" },
  { key: "source", label: "source" },
  { key: "language", label: "language" },
  { key: "score", label: "score" },
  { key: "matchedTerms", label: "matchedTerms" },
  { key: "snippet", label: "snippet" },
  { key: "indexedAt", label: "indexedAt" },
];

function cell(result: SearchResult, key: string): string {
  if (key.startsWith("pagination.")) return "";
  const v = (result as Record<string, unknown>)[key];
  if (Array.isArray(v)) return v.join("|");
  if (v === undefined || v === null) return "";
  return String(v);
}

export function serializeSearchResponse(response: SearchResponse, format: OutputFormat): SerializedOutput {
  let body: string;
  switch (format) {
    case "json":
      body = JSON.stringify(response, null, 2);
      break;
    case "xml": {
      const items = response.results
        .map(
          (r) => `<result score="${escapeXml(String(r.score))}">
      <id>${escapeXml(r.id)}</id>
      <title>${escapeXml(r.title)}</title>
      <url>${escapeXml(r.url)}</url>
      <canonicalUrl>${escapeXml(r.canonicalUrl)}</canonicalUrl>
      <description>${escapeXml(r.description)}</description>
      <source>${escapeXml(r.source)}</source>
      <matchedTerms>${r.matchedTerms.map((t) => `<term>${escapeXml(t)}</term>`).join("")}</matchedTerms>
      <snippet>${escapeXml(r.snippet)}</snippet>
      <indexedAt>${escapeXml(r.indexedAt)}</indexedAt>
    </result>`
        )
        .join("\n    ");
      body = `<?xml version="1.0" encoding="UTF-8"?>
<searchResponse>
  <query>${escapeXml(response.query)}</query>
  <scope>${escapeXml(response.scope)}</scope>
  <indexSize>${response.indexSize}</indexSize>
  <tookMs>${response.tookMs}</tookMs>
  <pagination page="${response.pagination.page}" limit="${response.pagination.limit}" total="${response.pagination.total}" totalPages="${response.pagination.totalPages}"/>
  <results>
    ${items}
  </results>
</searchResponse>`;
      break;
    }
    case "csv": {
      const header = RESULT_COLUMNS.map((c) => escapeCsvField(c.label)).join(",");
      const rows = response.results.map((r) => RESULT_COLUMNS.map((c) => escapeCsvField(cell(r, c.key))).join(","));
      body = [header, ...rows].join("\r\n") + "\r\n";
      break;
    }
    case "markdown": {
      const lines = [
        `# Search results for “${response.query}”`,
        "",
        `_Scope: ${response.scope} · ${response.pagination.total} match(es) · page ${response.pagination.page}/${response.pagination.totalPages} · ${response.tookMs}ms_`,
        "",
      ];
      for (const r of response.results) {
        lines.push(
          `## [${r.title || "(untitled)"}](${sanitizeMarkdownLink(r.url)})`,
          "",
          r.description ? `${r.description}` : "",
          r.snippet ? `\n> ${r.snippet}` : "",
          ``,
          `- Source: \`${r.source}\` · Score: **${r.score}** · Indexed: ${r.indexedAt}`,
          r.matchedTerms.length ? `- Matched terms: ${r.matchedTerms.map((t) => `\`${t}\``).join(", ")}` : "",
          ``
        );
      }
      body = lines.filter((l) => l !== "").join("\n").concat("\n");
      break;
    }
    case "text": {
      const lines = [`Search results for: ${response.query}`, `Matches: ${response.pagination.total}`, ""];
      response.results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title}`, `   ${r.url}`, `   score=${r.score} source=${r.source}`, r.snippet ? `   ${r.snippet}` : "", "");
      });
      body = lines.join("\n");
      break;
    }
    case "html": {
      const items = response.results
        .map(
          (r) =>
            `<li><a href="${escapeHtml(safeHref(r.url))}" rel="noopener noreferrer">${escapeHtml(r.title)}</a>` +
            `<div class="url">${escapeHtml(r.url)}</div>` +
            (r.description ? `<p>${escapeHtml(r.description)}</p>` : "") +
            (r.snippet ? `<blockquote>${escapeHtml(r.snippet)}</blockquote>` : "") +
            `<small>score ${escapeHtml(String(r.score))} · ${escapeHtml(r.source)} · indexed ${escapeHtml(r.indexedAt)}</small></li>`
        )
        .join("\n");
      body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TixlogicSearch results</title></head>` +
        `<body><h1>Results for “${escapeHtml(response.query)}”</h1><p>${response.pagination.total} match(es), scope: ${escapeHtml(response.scope)}.</p><ol>${items}</ol></body></html>`;
      break;
    }
    case "ndjson": {
      body = response.results.map((r) => JSON.stringify(r)).join("\n") + (response.results.length ? "\n" : "");
      break;
    }
    default:
      body = JSON.stringify(response, null, 2);
      format = "json";
  }
  return { body, contentType: FORMAT_MIME[format] };
}

function sanitizeMarkdownLink(url: string): string {
  const safe = safeHref(url);
  return safe.replace(/[()]/g, encodeURIComponent);
}

export function safeHref(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return url;
  } catch {
    /* fallthrough */
  }
  return "#";
}

/** Serialize an API error consistently across formats. */
export function serializeError(
  errorBody: { error: { code: string; message: string; requestId: string; details?: unknown } },
  format: OutputFormat
): SerializedOutput {
  const e = errorBody.error;
  switch (format) {
    case "xml":
      return {
        body: `<?xml version="1.0" encoding="UTF-8"?><error><code>${escapeXml(e.code)}</code><message>${escapeXml(e.message)}</message><requestId>${escapeXml(e.requestId)}</requestId></error>`,
        contentType: FORMAT_MIME.xml,
      };
    case "csv":
      return { body: `field,value\r\ncode,${escapeCsvField(e.code)}\r\nmessage,${escapeCsvField(e.message)}\r\nrequestId,${escapeCsvField(e.requestId)}\r\n`, contentType: FORMAT_MIME.csv };
    case "markdown":
      return { body: `# Error \`${e.code}\`\n\n${e.message}\n\n_Request ID:_ \`${e.requestId}\``, contentType: FORMAT_MIME.markdown };
    case "text":
      return { body: `ERROR ${e.code}: ${e.message} (request ${e.requestId})`, contentType: FORMAT_MIME.text };
    case "html":
      return { body: `<div class="error"><strong>${escapeHtml(e.code)}</strong>: ${escapeHtml(e.message)}<br/><small>${escapeHtml(e.requestId)}</small></div>`, contentType: FORMAT_MIME.html };
    case "ndjson":
      return { body: JSON.stringify(errorBody) + "\n", contentType: FORMAT_MIME.ndjson };
    default:
      return { body: JSON.stringify(errorBody, null, 2), contentType: FORMAT_MIME.json };
  }
}

/* --------------------------- import validation -------------------------- */

import { z } from "zod";

export const exportBundleSchema = z.object({
  app: z.literal("TixlogicSearch"),
  version: z.number().int().min(1),
  exportedAt: z.string(),
  documents: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        url: z.string().url().max(2048),
        canonicalUrl: z.string().url().max(2048),
        title: z.string().max(500),
        description: z.string().max(2000),
        content: z.string().max(2_000_000),
        headings: z.array(z.string().max(500)).max(200),
        keywords: z.array(z.string().max(100)).max(100),
        source: z.string().max(253),
        language: z.string().max(35),
        contentHash: z.string().min(16).max(128),
        indexedAt: z.string(),
        updatedAt: z.string(),
      })
    )
    .max(5000),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type ExportBundle = z.infer<typeof exportBundleSchema>;
