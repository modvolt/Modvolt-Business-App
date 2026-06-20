import { db } from "../db/index.js";
import { appSettings } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Čtení nastavení aplikace za běhu (z tabulky app_settings).
// Krátká in-memory cache, aby se každý dotaz nemusel ptát databáze, ale
// změny z admin panelu se projeví bez restartu (redeploy) - po uložení se
// cache invaliduje a další čtení načte aktuální hodnoty.
// ---------------------------------------------------------------------------

const TTL_MS = 10_000;

let cache: { values: Record<string, string | null>; loadedAt: number } | null =
  null;

export async function getAllSettings(
  force = false,
): Promise<Record<string, string | null>> {
  if (!force && cache && Date.now() - cache.loadedAt < TTL_MS) {
    return cache.values;
  }
  const rows = await db.select().from(appSettings);
  const values: Record<string, string | null> = {};
  for (const r of rows) values[r.key] = r.value;
  cache = { values, loadedAt: Date.now() };
  return values;
}

export async function getSetting(key: string): Promise<string | null> {
  const all = await getAllSettings();
  return all[key] ?? null;
}

/** Vymaže cache - volat po každém uložení nastavení, aby se změny projevily ihned. */
export function invalidateSettingsCache(): void {
  cache = null;
}
