import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { env } from "../env.js";
import { seedDefaults } from "./seed-defaults.js";
import { seedAdmin } from "./seed-admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Najde složku s migracemi (./drizzle). Cesta se liší podle toho, zda běžíme
 * ze zdroje (tsx: src/server/db) nebo z bundlu (esbuild: dist/server/index.js),
 * proto zkoušíme více kandidátů a vrátíme první existující.
 */
function findMigrationsFolder(): string {
  const candidates = [
    path.resolve(__dirname, "../../../drizzle"), // src/server/db -> root/drizzle
    path.resolve(__dirname, "../../drizzle"), // dist/server -> root/drizzle (bundle)
    path.resolve(process.cwd(), "drizzle"), // spuštěno z rootu projektu
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "meta", "_journal.json"))) {
      return dir;
    }
  }
  // Záložní volba: cwd/drizzle (chyba se projeví hlasitě při migraci).
  return path.resolve(process.cwd(), "drizzle");
}

/**
 * Aplikuje všechny čekající migrace, vytvoří pgvector rozšíření a doplní
 * výchozí kategorie/nastavení. Funkce je idempotentní – lze ji bezpečně
 * spustit při každém startu serveru. Vyhazuje chybu, pokud cokoli selže,
 * aby nasazení selhalo hlasitě místo servírování rozbitého schématu.
 */
export async function runMigrations(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL není nastaveno.");
  }
  const migrationsFolder = findMigrationsFolder();
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 1 });
  try {
    const db = drizzle(pool);

    // pgvector rozšíření musí existovat před migrací (vector typ + hnsw index).
    console.log("Vytvářím rozšíření pgvector (pokud chybí)...");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    console.log("Spouštím migrace z:", migrationsFolder);
    await migrate(db, { migrationsFolder });

    console.log("Seeduji výchozí kategorie a nastavení...");
    await seedDefaults(pool);

    console.log("Zakládám admin účet (pokud chybí)...");
    await seedAdmin(db);

    console.log("Migrace dokončeny.");
  } finally {
    await pool.end();
  }
}
