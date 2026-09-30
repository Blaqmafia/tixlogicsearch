import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/components/AppProviders";
import { TopNav } from "@/components/TopNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "TixlogicSearch — AI-Powered Search by Tixlogic",
    template: "%s · TixlogicSearch",
  },
  description:
    "Professional AI-powered search engine with local IndexedDB persistence, custom BM25/TF-IDF ranking, secure web retrieval and reusable APIs.",
  icons: {
    icon: "/favicon.ico",
  },
  applicationName: "TixlogicSearch",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased theme-light`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <AppProviders>
          <TopNav />
          <main className="flex-1 w-full">{children}</main>
          <footer className="border-t border-line py-6 px-4 text-xs text-muted flex flex-wrap items-center justify-between gap-2">
            <span>© {new Date().getFullYear()} Tixlogic — TixlogicSearch</span>
            <span>
              Data is stored locally in your browser (IndexedDB).{" "}
              <a className="text-cobalt hover:underline" href="/settings">
                Privacy &amp; storage controls
              </a>
            </span>
          </footer>
        </AppProviders>
      </body>
    </html>
  );
}
