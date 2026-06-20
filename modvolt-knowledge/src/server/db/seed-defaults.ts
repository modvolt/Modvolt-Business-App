import type pg from "pg";
import { DEFAULT_CSN_LOCK_KEYWORDS } from "../search/source-mode.js";

const DEFAULT_CATEGORIES = [
  "Elektro normy",
  "Rozvaděče",
  "Revize",
  "PRE / ČEZ / EG.D",
  "BOZP",
  "PPN",
  "Slaboproud",
  "Loxone",
  "Jablotron",
  "Hikvision",
  "Ubiquiti / UniFi",
  "CCTV / Kamerové systémy",
  "Tepelná čerpadla",
  "Klimatizace",
  "Interní postupy Modvolt",
  "Šablony dokumentů",
  "Návody výrobců",
  "Technické listy",
  "Smlouvy a právní dokumenty",
  "Ostatní",
];

const DEFAULT_SETTINGS: Record<string, string> = {
  ai_prompt_version: "v1",
  ai_enabled: "false",
  image_analysis_enabled: "false",
  web_search_enabled: "false",
  default_context_chunks: "8",
  default_search_mode: "auto",
  allow_user_uploads: "false",
  max_upload_mb: "50",
  max_image_upload_mb: "15",
  csn_lock_keywords: DEFAULT_CSN_LOCK_KEYWORDS.join("\n"),
};

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export async function seedDefaults(pool: pg.Pool): Promise<void> {
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    const name = DEFAULT_CATEGORIES[i];
    const slug = slugify(name);
    await pool.query(
      `INSERT INTO document_categories (name, slug, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [name, slug, i],
    );
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO app_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
  }
}
