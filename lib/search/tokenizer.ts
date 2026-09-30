/**
 * Query processing & tokenization (platform-independent, runs on client and server).
 */

export interface TokenizeOptions {
  removeStopWords?: boolean;
  stemming?: boolean;
}

/** Default English stop words. Configurable via settings ("search.stopWords"). */
export const DEFAULT_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
  "could", "did", "do", "does", "for", "from", "had", "has", "have", "he",
  "her", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my",
  "no", "not", "of", "on", "or", "our", "she", "so", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "to",
  "too", "us", "was", "we", "were", "what", "when", "where", "which", "who",
  "why", "will", "with", "would", "you", "your",
]);

/** Normalize whitespace and trim. */
export function normalizeInput(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * Unicode-aware tokenization: splits on any character that is not a
 * Unicode letter, number or mark; keeps emoji-free word tokens lowercased.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const { removeStopWords = false, stemming = false } = options;
  if (!text) return [];
  // \p{L}\p{N}\p{M} cover letters/numbers/combining marks across scripts.
  const raw = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}_-]+/u)
    .filter((t) => t.length > 0 && t.length <= 64);
  let tokens = raw;
  if (removeStopWords) {
    tokens = tokens.filter((t) => !DEFAULT_STOP_WORDS.has(t));
  }
  if (stemming) {
    tokens = tokens.map(stemWord);
  }
  return tokens;
}

/**
 * Light Porter-style suffix stripper. Intentionally conservative: it only
 * removes common inflectional suffixes and never shortwords below 4 chars.
 */
export function stemWord(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  // step-like rules (simplified)
  const rules: Array<[RegExp, string]> = [
    [/ies$/, "y"],           // studies -> study
    [/sses$/, "ss"],         // classes -> classs -> class (handled below)
    [/ses$/, "s"],           // phases -> phase-ish
    [/ing$|ings$/, ""],      // running -> runn (fixed by double-consonant rule)
    [/edly$/, "ed"],
    [/ly$/, ""],
    [/es$/, ""],             // boxes -> box
    [/s$/, ""],              // cats -> cat (avoid stripping ss)
  ];
  if (/ss$/.test(w)) return w;
  for (const [re, rep] of rules) {
    if (re.test(w) && w.length > 4) {
      w = w.replace(re, rep);
      break;
    }
  }
  // collapse trailing doubled consonants left by -ing removal (runn -> run)
  if (/([bdfglmnprt])\1$/.test(w) && w.length > 3) {
    w = w.slice(0, -1);
  }
  return w;
}

export interface ParsedQuery {
  normalized: string;
  /** all content tokens (stop words kept — they matter for phrase matching) */
  tokens: string[];
  /** significant tokens used for inverted-index lookup */
  searchTokens: string[];
  /** exact phrases from "quoted segments" */
  phrases: string[];
}

/**
 * Parse a user query: extract quoted exact phrases, tokenize the rest,
 * optionally strip stop words and apply stemming for index lookups.
 */
export function parseQuery(
  input: string,
  options: { stopWords?: Set<string>; stemming?: boolean } = {}
): ParsedQuery {
  const stemming = options.stemming ?? false;
  const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;
  const normalized = normalizeInput(input);

  const phrases: string[] = [];
  const remainder = normalized.replace(/"([^"]+)"/g, (_m, p1: string) => {
    const phrase = normalizeInput(p1).toLowerCase();
    if (phrase) phrases.push(phrase);
    return " ";
  });

  const tokens = tokenize(remainder, { removeStopWords: false, stemming: false });
  const searchTokens: string[] = [];
  for (const t of tokens) {
    if (stopWords.has(t)) continue;
    searchTokens.push(stemming ? stemWord(t) : t);
  }
  // Also add stemmed phrase words so phrases contribute to term lookup.
  for (const phrase of phrases) {
    for (const t of tokenize(phrase)) {
      if (stopWords.has(t)) continue;
      const s = stemming ? stemWord(t) : t;
      if (!searchTokens.includes(s)) searchTokens.push(s);
    }
  }
  return { normalized, tokens, searchTokens, phrases };
}

/** Maximum accepted query length (characters). */
export const MAX_QUERY_LENGTH = 512;

export function validateQuery(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "query must be a string" };
  const q = normalizeInput(raw);
  if (q.length === 0) return { ok: false, error: "query is empty after normalization" };
  if (q.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `query exceeds ${MAX_QUERY_LENGTH} characters` };
  }
  const quoteCount = (q.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    return { ok: false, error: "unbalanced quotation marks in query" };
  }
  return { ok: true, value: q };
}
