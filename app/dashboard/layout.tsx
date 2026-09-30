import type { Metadata } from "next";
import { StorageBanner } from "@/components/StorageBanner";
import { DashboardNav } from "@/components/DashboardNav";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Manage your local index, documents, crawls, history and integrations.",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted mt-1">Everything here is stored locally in this browser unless you use the server API.</p>
      </div>
      <StorageBanner />
      <DashboardNav />
      {children}
    </div>
  );
}
