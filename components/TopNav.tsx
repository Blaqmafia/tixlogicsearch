"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Menu, X, Settings as SettingsIcon, Sun, Moon } from "lucide";
import { useAppState } from "@/components/AppProviders";

const LINKS = [
  { href: "/search", label: "Search" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { settings, setTheme } = useAppState();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    router.push(`/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 shrink-0" aria-label="TixlogicSearch home">
          <Image src="/logo.png" alt="Tixlogic logo" width={112} height={28} className="h-7 w-auto" priority />
        </Link>

        <form onSubmit={submit} role="search" className="hidden md:flex flex-1 max-w-md">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your index…"
            aria-label="Quick search"
            className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm focus:border-cobalt"
          />
          <button type="submit" className="ml-2 rounded-lg bg-cobalt px-3 py-1.5 text-sm font-medium text-white hover:bg-cobalt-strong">
            Go
          </button>
        </form>

        <nav className="ml-auto hidden md:flex items-center gap-1" aria-label="Primary">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                pathname?.startsWith(l.href) ? "bg-cobalt-soft text-cobalt" : "text-muted hover:text-foreground"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <button
            onClick={() => setTheme(settings.theme === "dark" ? "light" : "dark")}
            className="rounded-lg p-2 text-muted hover:text-foreground"
            title="Toggle theme"
            aria-label="Toggle color theme"
          >
            {settings.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </nav>

        <button className="md:hidden ml-auto rounded-lg p-2 text-muted" onClick={() => setOpen(!open)} aria-label="Toggle menu" aria-expanded={open}>
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {open && (
        <div className="md:hidden border-t border-line px-4 py-3 space-y-2 bg-surface">
          <form onSubmit={submit} role="search" className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="flex-1 rounded-lg border border-line bg-background px-3 py-2 text-sm"
            />
            <button type="submit" className="rounded-lg bg-cobalt px-3 py-2 text-sm font-medium text-white">Go</button>
          </form>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="block rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-cobalt-soft">
              {l.label}
            </Link>
          ))}
          <Link href="/settings" className="block rounded-lg px-3 py-2 text-sm text-muted">
            <SettingsIcon size={14} className="inline mr-1" /> Storage &amp; privacy
          </Link>
          <button
            onClick={() => setTheme(settings.theme === "dark" ? "light" : "dark")}
            className="block w-full text-left rounded-lg px-3 py-2 text-sm text-muted"
          >
            Theme: {settings.theme === "dark" ? "Dark" : "Light"} — tap to switch
          </button>
        </div>
      )}
    </header>
  );
}
