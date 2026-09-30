"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { localSearch, type LocalSettings } from "@/services/local-search-service";
import { DEFAULT_SETTINGS } from "@/services/local-search-service";

interface AppState {
  ready: boolean;
  storageError: string | null;
  settings: LocalSettings;
  setTheme: (t: "light" | "dark") => void;
  refreshSettings: () => Promise<void>;
  bump: () => void; // notify consumers data changed (docs/index/history)
  version: number;
}

const Ctx = createContext<AppState>({
  ready: false,
  storageError: null,
  settings: DEFAULT_SETTINGS,
  setTheme: () => {},
  refreshSettings: async () => {},
  bump: () => {},
  version: 0,
});

export function useAppState() {
  return useContext(Ctx);
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        await localSearch.init();
        const s = await localSearch.loadSettings();
        if (mounted.current) {
          setSettings(s);
          applyTheme(s.theme);
          setReady(true);
        }
      } catch (e) {
        if (mounted.current) {
          setStorageError(e instanceof Error ? e.message : String(e));
          setReady(true); // allow UI to render with error banner
        }
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyThemeAndPersist = async (t: "light" | "dark") => {
    applyTheme(t);
    try {
      const s = await localSearch.saveSettings({ theme: t });
      setSettings(s);
    } catch {
      /* theme persistence is best-effort */
    }
  };

  const refreshSettings = async () => {
    const s = await localSearch.loadSettings();
    setSettings(s);
    applyTheme(s.theme);
  };

  return (
    <Ctx.Provider
      value={{
        ready,
        storageError,
        settings,
        setTheme: applyThemeAndPersist,
        refreshSettings,
        bump: () => setVersion((v) => v + 1),
        version,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

function applyTheme(t: "light" | "dark") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("theme-dark", t === "dark");
  root.classList.toggle("theme-light", t !== "dark");
}
