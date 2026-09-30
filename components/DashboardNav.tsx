"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "/dashboard", label: "Overview", exact: true },
  { href: "/dashboard/documents", label: "Documents" },
  { href: "/dashboard/index", label: "Index" },
  { href: "/dashboard/crawler", label: "Crawler" },
  { href: "/dashboard/history", label: "History" },
  { href: "/dashboard/api", label: "API & Integrations" },
];

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Dashboard sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1.5">
      {SECTIONS.map((s) => {
        const active = s.exact ? pathname === s.href : pathname.startsWith(s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-cobalt text-white" : "text-muted hover:text-foreground hover:bg-cobalt-soft"
            }`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
