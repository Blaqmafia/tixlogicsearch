import { Suspense } from "react";
import type { Metadata } from "next";
import { SearchClient } from "@/components/SearchClient";
import { StorageBanner } from "@/components/StorageBanner";
import { Spinner } from "@/components/ui";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage() {
  return (
    <>
      <StorageBanner />
      <Suspense fallback={<div className="flex justify-center py-20"><Spinner label="Loading search…" /></div>}>
        <SearchClient />
      </Suspense>
    </>
  );
}
