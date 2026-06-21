import { pool, db } from "./index.js";
import { seedAdmin } from "./seed-admin.js";

// CLI: vynutí reset admin účtu na hodnoty z env (ADMIN_EMAIL/ADMIN_PASSWORD).
async function main() {
  await seedAdmin(db, { force: true });
  await pool.end();
}

main().catch((err) => {
  console.error("Seed admina selhal:", err);
  process.exit(1);
});
