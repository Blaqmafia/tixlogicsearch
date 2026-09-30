"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Search, Sparkles, Globe, Database, Gauge, Plug } from "lucide";
import { Card } from "@/components/ui";

export function HomeClient() {
  const router = useRouter();
  const [q, setQ] = useState("");

  const go = (e?: FormEvent) => {
    e?.preventDefault();
    const term = q.trim();
    if (!term) return;
    router.push(`/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <div className="mx-auto max-w-6xl px-4">
      {/* Hero */}
      <section className="flex flex-col items-center text-center pt-16 pb-10">
        <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight">
          Your index. <span className="text-cobalt">Your search engine.</span>
        </h1>
        <p className="mt-4 max-w-xl text-muted text-sm sm:text-base">
          TixlogicSearch runs a real inverted index with BM25/TF-IDF ranking entirely in your browser,
          retrieves web pages through a hardened server-side crawler, and answers questions grounded in actual sources.
        </p>

        <form onSubmit={go} role="search" className="mt-8 w-full max-w-xl">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2 shadow-sm focus-within:border-cobalt">
            <Search size={18} className="ml-2 text-muted shrink-0" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search indexed content, or ask something…"
              aria-label="Search query"
              className="flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted/70"
            />
            <button type="submit" className="rounded-lg bg-cobalt px-4 py-2 text-sm font-medium text-white hover:bg-cobalt-strong">
              Search
            </button>
          </div>
        </form>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button onClick={() => router.push("/search")} className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-muted hover:border-cobalt hover:text-cobalt">
            Open full search
          </button>
          <button onClick={() => router.push("/dashboard/crawler")} className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-muted hover:border-cobalt hover:text-cobalt">
            Retrieve a website
          </button>
          <button onClick={() => router.push("/dashboard/index")} className="rounded-full border border-line px-4 py-1.5 text-xs font-medium text-muted hover:border-cobalt hover:text-cobalt">
            Manage index
          </button>
        </div>
      </section>

      {/* Feature grid */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 pb-16">
        <Card>
          <Database size={20} className="text-cobalt" />
          <h2 className="mt-3 text-sm font-semibold">Local IndexedDB persistence</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Documents, inverted index, history, caches and settings live only in this browser — exportable, importable, deletable by you.
          </p>
        </Card>
        <Card>
          <Gauge size={20} className="text-cobalt" />
          <h2 className="mt-3 text-sm font-semibold">Custom ranking engine</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Hand-written BM25 &amp; TF-IDF with title/heading boosts, exact-phrase bonuses, freshness signals and duplicate suppression.
          </p>
        </Card>
        <Card>
          <Globe size={20} className="text-cobalt" />
          <h2 className="mt-3 text-sm font-semibold">Secure web retrieval</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Server-side crawler with SSRF defenses, DNS-rebinding protection, robots.txt compliance and bounded depth/pages.
          </p>
        </Card>
        <Card>
          <Sparkles size={20} className="text-cobalt" />
          <h2 className="mt-3 text-sm font-semibold">Grounded AI answers</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Optional OpenRouter integration produces source-cited answers; citations are verified against actually retrieved URLs. Falls back to plain search when unconfigured.
          </p>
        </Card>
        <Card>
          <Plug size={20} className="text-cobalt" />
          <h2 className="mt-3 text-sm font-semibold">Reusable versioned API</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Scoped integration credentials, rate limits, JSON/XML/CSV/Markdown/text/HTML/NDJSON output under <code>/api/v1</code>.
          </p>
        </Card>
        <Card>
          <Search size={20} className="text-cobalt" />
          <h2 className="mt-3 text-sm font-semibold">Honest results</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Only real indexed documents are returned — never fabricated results, metrics or invented sources.
          </p>
        </Card>
      </section>
    </div>
  );
}
