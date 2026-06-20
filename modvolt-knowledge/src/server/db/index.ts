import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

if (!env.databaseUrl) {
  throw new Error(
    "DATABASE_URL není nastaveno. Nastav standardní PostgreSQL connection string.",
  );
}

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 5,
});

export const db = drizzle(pool, { schema });

export { schema };
