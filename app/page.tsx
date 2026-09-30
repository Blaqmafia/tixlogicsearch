import type { Metadata } from "next";
import { HomeClient } from "@/components/HomeClient";

export const metadata: Metadata = {
  title: "TixlogicSearch — AI-Powered Search by Tixlogic",
};

export default function Home() {
  return <HomeClient />;
}
