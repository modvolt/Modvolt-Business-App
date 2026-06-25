import { createApp } from "./app.js";
import { env, validateEnv } from "./env.js";
import { logger } from "./lib/logger.js";
import { runMigrations } from "./db/migrate.js";
import { startIndexingWorker } from "./indexing/worker.js";
import { startBulkImportWorker } from "./indexing/bulk-import-worker.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Poslední záchranná síť na úrovni procesu. Bez těchto handlerů by jakékoli
// neošetřené odmítnutí Promise nebo výjimka mimo request cyklus (workery,
// timery) shodily celý server. Místo tichého pádu je zalogujeme a běžíme dál.
process.on("unhandledRejection", (reason) => {
  logger.error(
    "Neošetřené odmítnutí Promise",
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  );
});

process.on("uncaughtException", (err) => {
  logger.error("Neošetřená výjimka", err?.stack ?? String(err));
});

async function main() {
  validateEnv();

  // Aplikuj čekající migrace PŘED servírováním provozu. Pokud selžou, start
  // selže hlasitě místo toho, aby server běžel proti zastaralému schématu
  // (chybějící sloupec = pád každého /search a /ask požadavku).
  logger.info("Aplikuji čekající databázové migrace...");
  try {
    await runMigrations();
  } catch (err) {
    logger.error(
      "Databázové migrace selhaly – server se nespustí. Zkontrolujte DATABASE_URL a dostupnost databáze.",
      String(err),
    );
    throw err;
  }
  logger.info("Databázové migrace jsou aktuální.");

  const app = createApp();

  if (env.isProduction) {
    // Produkce: servíruj postavený frontend z dist/public.
    const publicDir = path.resolve(__dirname, "../public");
    app.use(express.static(publicDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path === "/health") return next();
      res.sendFile(path.join(publicDir, "index.html"));
    });
  } else {
    // Vývoj: Vite v middleware módu (řeší host-check a HMR).
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: path.resolve(__dirname, "../../src/client"),
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  startIndexingWorker();
  startBulkImportWorker();

  app.listen(env.port, "0.0.0.0", () => {
    logger.info(`Modvolt Knowledge běží na portu ${env.port} (${env.nodeEnv}).`);
  });
}

main().catch((err) => {
  logger.error("Start serveru selhal", String(err));
  process.exit(1);
});
