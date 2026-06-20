import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { env } from "../env.js";
import { seedDefaults } from "./seed-defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Migrace jsou v ./drizzle v rootu projektu.
const migrationsFolder = path.resolve(__dirname, "../../../drizzle");

async function main() {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL není nastaveno.");
  }
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 1 });
  const db = drizzle(pool);

  // pgvector rozšíření musí existovat před migrací (vector typ + hnsw index).
  console.log("Vytvářím rozšíření pgvector (pokud chybí)...");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  console.log("Spouštím migrace z:", migrationsFolder);
  await migrate(db, { migrationsFolder });

  console.log("Seeduji výchozí kategorie a nastavení...");
  await seedDefaults(pool);

  console.log("Migrace dokončeny.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migrace selhaly:", err);
  process.exit(1);
});
