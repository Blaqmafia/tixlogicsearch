"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Database, Search, History as HistoryIcon, Activity, HardDrive, FileText, Globe, Plug, Zap } from "lucide-react";
import { localSearch } from "@/services/local-search-service";
import { getStorageStatus } from "@/lib/storage/idb";
import { useAppState } from "@/components/AppProviders";
import { Card, CardTitle, Stat, Spinner, Button, Badge } from "@/components/ui";
import type { StorageStatus } from "@/lib/storage/idb";

interface Stats {
  documents: number;
  terms: number;
  searches: number;
  logs: number;
  jobs: number;
  topTerms: Array<{ term: string; docs: number }>;
  domains: Array<{ domain: string; count: number }>;
}

export function OverviewClient() {
  const { ready, version } = useAppState();
  const [stats, setStats] = useState<Stats | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    (async () => {
      try {
        const s = await localSearch.getStats();
        const st = await getStorageStatus();
        if (alive) { setStats(s); setStorage(st); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [ready, version]);

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!stats ? (
        <div className="flex justify-center py-12"><Spinner label="Reading local storage…" /></div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Documents" value={stats.documents} sub="in your local index" />
            <Stat label="Index terms" value={stats.terms.toLocaleString()} sub="distinct tokens" />
            <Stat label="Searches" value={stats.searches} sub="recorded history" />
            <Stat label="Crawl jobs" value={stats.jobs} sub="stored runs" />
            <Stat label="Log entries" value={stats.logs} sub="activity log" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardTitle icon={<Database size={14} />}>Storage status</CardTitle>
              {storage && (
                <ul className="space-y-2 text-sm">
                  <li className="flex justify-between"><span className="text-muted">Database</span><span className="font-mono text-xs">{storage.database}</span></li>
                  <li className="flex justify-between"><span className="text-muted">Persistence granted</span><Badge tone={storage.persisted ? "green" : "amber"}>{storage.persisted ? "yes" : "best-effort"}</Badge></li>
                  {storage.usage !== undefined && (
                    <li className="flex justify-between"><span className="text-muted">Usage</span><span className="font-mono text-xs">{(storage.usage / 1024 / 1024).toFixed(2)} MB{storage.quota ? ` of ${(storage.quota / 1024 / 1024).toFixed(0)} MB` : ""}</span></li>
                  )}
                  <li className="flex justify-between"><span className="text-muted">Supported</span><Badge tone={storage.supported ? "green" : "red"}>{storage.supported ? "IndexedDB OK" : "unsupported"}</Badge></li>
                </ul>
              )}
              <Link href="/settings" className="mt-4 inline-flex items-center gap-1 text-sm text-cobalt hover:underline"><HardDrive size={13} /> Storage & privacy controls</Link>
            </Card>

            <Card>
              <CardTitle icon={<FileText size={14} />}>Top indexed terms</CardTitle>
              {stats.topTerms.length === 0 ? (
                <p className="text-xs text-muted">No terms yet — add documents or run a crawl to build the inverted index.</p>
              ) : (
                <ul className="space-y-1">
                  {stats.topTerms.map((t) => (
                    <li key={t.term} className="flex justify-between text-sm">
                      <Link href={`/search?q=${encodeURIComponent(t.term)}`} className="text-cobalt hover:underline font-mono text-xs">{t.term}</Link>
                      <span className="text-muted text-xs">{t.docs} doc(s)</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardTitle icon={<Globe size={14} />}>Coverage by domain</CardTitle>
              {stats.domains.length === 0 ? (
                <p className="text-xs text-muted">Nothing crawled yet.</p>
              ) : (
                <ul className="space-y-1">
                  {stats.domains.map((d) => (
                    <li key={d.domain} className="flex justify-between text-sm">
                      <Link href={`/search?mode=website&domain=${encodeURIComponent(d.domain)}`} className="text-cobalt hover:underline">{d.domain}</Link>
                      <span className="text-muted text-xs">{d.count} page(s)</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardTitle icon={<Zap size={14} />}>Quick actions</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Link href="/search"><Button variant="secondary"><Search size={14} /> Search</Button></Link>
              <Link href="/dashboard/documents"><Button variant="secondary"><FileText size={14} /> Add documents</Button></Link>
              <Link href="/dashboard/crawler"><Button variant="secondary"><Globe size={14} /> Retrieve a website</Button></Link>
              <Link href="/dashboard/index"><Button variant="secondary"><Database size={14} /> Inspect index</Button></Link>
              <Link href="/dashboard/history"><Button variant="secondary"><HistoryIcon size={14} /> Search history</Button></Link>
              <Link href="/dashboard/api"><Button variant="secondary"><Plug size={14} /> Integrations</Button></Link>
              <Link href="/settings"><Button variant="secondary"><Activity size={14} /> Settings</Button></Link>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
