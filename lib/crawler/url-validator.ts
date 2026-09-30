/**
 * Secure URL validation & SSRF defenses (platform-independent logic; DNS
 * checks are performed server-side where dns.promises is available).
 */

const PRIVATE_V4_RANGES: Array<{ mask: number[]; bits: number }> = [
  { mask: [0, 0, 0, 0], bits: 8 }, // 0.0.0.0/8 "this network"
  { mask: [10, 0, 0, 0], bits: 8 }, // 10/8
  { mask: [100, 64, 0, 0], bits: 10 }, // 100.64/10 CGNAT
  { mask: [127, 0, 0, 0], bits: 8 }, // loopback
  { mask: [169, 254, 0, 0], bits: 16 }, // link-local
  { mask: [172, 16, 0, 0], bits: 12 }, // 172.16/12
  { mask: [192, 0, 0, 0], bits: 24 }, // IETF protocol assignments
  { mask: [192, 0, 2, 0], bits: 24 }, // TEST-NET-1
  { mask: [192, 168, 0, 0], bits: 16 }, // private
  { mask: [198, 18, 0, 0], bits: 15 }, // benchmarking
  { mask: [198, 51, 100, 0], bits: 24 }, // TEST-NET-2
  { mask: [203, 0, 113, 0], bits: 24 }, // TEST-NET-3
  { mask: [224, 0, 0, 0], bits: 3 }, // multicast
  { mask: [240, 0, 0, 0], bits: 4 }, // reserved / broadcast
];

function ipToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => parseInt(p, 10));
  if (bytes.some((b) => !Number.isFinite(b) || b < 0 || b > 255 || String(b) !== p)) return null;
  return bytes;
}

export function isPrivateIPv4(ip: string): boolean {
  const bytes = ipToBytes(ip);
  if (!bytes) return false;
  for (const range of PRIVATE_V4_RANGES) {
    let matches = true;
    let remaining = range.bits;
    for (let i = 0; i < 4 && remaining > 0; i++) {
      const bitsHere = Math.min(8, remaining);
      const shift = 8 - bitsHere;
      const cmpMask = (0xff << shift) & 0xff;
      if ((bytes[i] & cmpMask) !== (range.mask[i] & cmpMask)) {
        matches = false;
        break;
      }
      remaining -= bitsHere;
    }
    if (matches) return true;
  }
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
  if (/^::ffff:/.test(lower)) {
    const v4 = lower.slice(7);
    if (ipToBytes(v4)) return isPrivateIPv4(v4);
  }
  if (/^2002:/.test(lower)) return false; // 6to4 — treat as public unless obviously private inner
  if (/^2001:db8:/.test(lower)) return true; // documentation prefix
  return false;
}

export function isPrivateIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set([80, 443]);

export interface UrlValidationResult {
  ok: boolean;
  url?: URL;
  error?: string;
}

/**
 * Strict syntactic + policy URL validation. Rejects non-http(s) schemes,
 * embedded credentials, disallowed ports, localhost/private literals and
 * blocked hostnames. Does NOT resolve DNS — use validateUrlResolved on the
 * server for full SSRF protection.
 */
export function validateUrlBasic(raw: string, opts: { allowLocalhost?: boolean } = {}): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "URL is not parseable" };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { ok: false, error: "Only http and https URLs are allowed" };
  if (url.username || url.password) return { ok: false, error: "URLs with embedded credentials are rejected" };
  const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) return { ok: false, error: `Port ${port} is not allowed (only 80/443)` };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, error: "Missing hostname" };
  if (host.endsWith(".local") || host === "localhost" || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    if (!opts.allowLocalhost) return { ok: false, error: "Local/internal hostnames are not allowed" };
  }
  // IPv4-in-decimal/octal/hex obfuscation e.g. http://2130706433
  if (/^\d+$/.test(host)) return { ok: false, error: "Numeric host literals are rejected" };
  if (host.includes(":") || /^\[/.test(url.hostname)) {
    if (isPrivateIPv6(url.hostname)) return { ok: false, error: "IPv6 literal resolves to a private/reserved address" };
  } else if (ipToBytes(host)) {
    if (isPrivateIPv4(host)) return { ok: false, error: "IPv4 literal resolves to a private/reserved address" };
  }
  if (url.pathname.includes("\\")) return { ok: false, error: "Backslashes in path are rejected" };
  return { ok: true, url };
}

export interface ResolvedAddress {
  address: string;
}

/**
 * Full server-side validation including DNS resolution of ALL records
 * (DNS-rebinding protection: every returned A/AAAA record must be public).
 * `resolve` is injectable for tests.
 */
export async function validateUrlResolved(
  raw: string,
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
): Promise<UrlValidationResult> {
  const basic = validateUrlBasic(raw);
  if (!basic.ok || !basic.url) return basic;
  const host = basic.url.hostname.replace(/^\[|\]$/g, "");
  // IP literals already checked by basic validation.
  if (ipToBytes(host) || host.includes(":")) return basic;
  let resolver = resolve;
  if (!resolver) {
    try {
      // Node built-in — only exists server-side.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dns = require("node:dns/promises") as typeof import("node:dns/promises");
      resolver = async (h: string) => {
        const [a, aaaa] = await Promise.all([
          dns.resolve4(h).catch(() => [] as string[]),
          dns.resolve6(h).catch(() => [] as string[]),
        ]);
        return [...a.map((address) => ({ address })), ...aaaa.map((address) => ({ address }))];
      };
    } catch {
      return { ok: false, error: "DNS validation unavailable in this environment" };
    }
  }
  let records: ResolvedAddress[];
  try {
    records = await resolver(host);
  } catch (e) {
    return { ok: false, error: `DNS resolution failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (records.length === 0) return { ok: false, error: "Hostname resolved to no addresses" };
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      return { ok: false, error: `Hostname resolves to private/reserved address ${r.address}` };
    }
  }
  return basic;
}

/** Canonicalize a URL for dedup: lowercase scheme/host, strip hash & common params, trailing slash. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    // drop common tracking parameters
    const tracking = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ref"];
    for (const t of tracking) u.searchParams.delete(t);
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw.trim();
  }
}

/** Resolve a possibly-relative href against a base URL; reject unsafe targets. */
export function resolveHref(href: string, baseUrl: URL): string | null {
  try {
    const u = new URL(href, baseUrl);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null;
    if (u.hostname.toLowerCase() !== baseUrl.hostname.toLowerCase()) return null; // same-host links only for crawl frontier
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
