import { createApp } from "./app.js";
import { env, validateEnv } from "./env.js";
import { logger } from "./lib/logger.js";
import { startIndexingWorker } from "./indexing/worker.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  validateEnv();
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

  app.listen(env.port, "0.0.0.0", () => {
    logger.info(`Modvolt Knowledge běží na portu ${env.port} (${env.nodeEnv}).`);
  });
}

main().catch((err) => {
  logger.error("Start serveru selhal", String(err));
  process.exit(1);
});
