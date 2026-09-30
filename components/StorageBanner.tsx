"use client";
import { useAppState } from "@/components/AppProviders";
import { ErrorNote } from "@/components/ui";

export function StorageBanner() {
  const { storageError } = useAppState();
  if (!storageError) return null;
  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <ErrorNote message={`Local storage unavailable: ${storageError}. Search and dashboard features that rely on IndexedDB are disabled in this browser/session.`} />
    </div>
  );
}
