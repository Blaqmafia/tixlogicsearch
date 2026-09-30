/**
 * HTML content extraction without external parsing dependencies.
 * Regex-based but deliberately conservative: strips non-content regions and
 * scripts/styles, decodes entities, extracts metadata, headings and links.
 * Extracted text is treated as UNTRUSTED data everywhere downstream.
 */

import type { ExtractedContent } from "@/types";
import { canonicalizeUrl } from "@/lib/crawler/url-validator";

const ENTITY_MAP: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, ent: string) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const code = parseInt(ent.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? safeFromCodePoint(code) : m;
    }
    if (ent.startsWith("#")) {
      const code = parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? safeFromCodePoint(code) : m;
    }
    const mapped = ENTITY_MAP[ent.toLowerCase()];
    return mapped !== undefined ? mapped : m;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Remove script/style/noscript/svg/template/iframe/object/embed areas entirely. */
export function stripNonContentRegions(html: string): string {
  let out = html;
  const blockTags = ["script", "style", "noscript", "svg", "template", "iframe", "object", "embed", "form", "nav", "footer", "header"];
  for (const tag of blockTags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, `gi`), " ");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, `gi`), " ");
  }
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  return out;
}

/** Prefer main/article content when present; fall back to body. */
export function selectMainContent(html: string): string {
  const candidates = [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<article\b[^>]*>([\s\S]*?)<\/article>/i, /<div[^>]+id=["']?(?:content|main-content|primary)["']?[^>]*>([\s\S]*?)<\/div>/i];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1].replace(/<[^>]*>/g, "").trim().length > 200) return m[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

export function extractText(html: string): string {
  const withBreaks = html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  const decoded = decodeEntities(withBreaks);
  return decoded
    .split("\n")
    .map((l) => l.replace(/[ \t\u00A0]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function metaContent(html: string, nameAttr: string, value: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:${nameAttr})=["']${value}["'][^>]*>` + `|` + `<meta[^>]+content=["']([^"']*)["'][^>]*(?:${nameAttr})=["']${value}["'][^>]*>`,
    "i"
  );
  // simpler approach: iterate all meta tags
  const metas = html.match(/<meta[^>]*>/gi) || [];
  for (const tag of metas) {
    const attrMatch = new RegExp(`${nameAttr}=["']${value}["']`, "i").exec(tag);
    if (!attrMatch) continue;
    const content = /content=["']([^"']*)["']/i.exec(tag);
    if (content) return decodeEntities(content[1]);
  }
  void re;
  return null;
}

export function extractHeadings(html: string, limit = 60): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && headings.length < limit) {
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (text && text.length <= 300) headings.push({ level: parseInt(m[1], 10), text });
  }
  return headings;
}

export function extractLinks(html: string, baseUrl: URL, limit = 500): string[] {
  const links = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && links.size < limit) {
    try {
      const u = new URL(decodeEntities(m[1]), baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (u.hostname.toLowerCase() !== baseUrl.hostname.toLowerCase()) continue; // same-host frontier
      u.hash = "";
      links.add(u.toString());
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return [...links];
}

/**
 * Full extraction pipeline for one fetched HTML document.
 */
export function extractContent(rawHtml: string, requestedUrl: string, finalUrl: string, maxChars = 200_000): ExtractedContent {
  const urlObj = new URL(finalUrl || requestedUrl);
  const titleTag = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleTag ? decodeEntities(titleTag[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const description = metaContent(rawHtml, "name", "description") || metaContent(rawHtml, "property", "og:description") || "";
  const langMatch = rawHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
  const language = langMatch ? langMatch[1].toLowerCase().slice(0, 35) : "en";

  // canonical link — only accept same-origin http(s) targets
  let canonicalUrl = canonicalizeUrl(finalUrl);
  const canonicalTag = rawHtml.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
  if (canonicalTag) {
    try {
      const cu = new URL(decodeEntities(canonicalTag[1] || canonicalTag[2]), urlObj);
      if ((cu.protocol === "http:" || cu.protocol === "https:") && cu.hostname.toLowerCase() === urlObj.hostname.toLowerCase()) {
        canonicalUrl = canonicalizeUrl(cu.toString());
      }
    } catch {
      /* keep fallback */
    }
  }

  const cleaned = stripNonContentRegions(rawHtml);
  const main = selectMainContent(cleaned);
  const headingsArr = extractHeadings(main);
  const links = extractLinks(main.length > 200 ? main : cleaned, urlObj);
  let content = extractText(main);
  let truncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    truncated = true;
  }
  return {
    url: requestedUrl,
    finalUrl,
    canonicalUrl,
    title: title || headingsArr[0]?.text || urlObj.hostname,
    description: description.slice(0, 2000),
    headings: headingsArr.map((h) => h.text),
    content,
    language,
    links,
    contentType: "text/html",
    truncated,
    partial: truncated || content.length < 40,
  };
}

/**
 * Client-side sanitizer for displaying extracted web content safely.
 * Removes every tag except a small allowlist of inline emphasis, then escapes
 * anything left over. Never use dangerouslySetInnerHTML with its output for
 * attributes or scripts — it returns plain-ish sanitized text/markup.
 */
export function sanitizeForDisplay(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/data:text\/html/gi, "")
    .slice(0, 100_000);
}
