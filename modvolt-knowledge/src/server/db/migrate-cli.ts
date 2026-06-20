import { runMigrations } from "./migrate.js";

// Samostatné CLI: `tsx src/server/db/migrate-cli.ts` (npm run db:migrate).
runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migrace selhaly:", err);
    process.exit(1);
  });
