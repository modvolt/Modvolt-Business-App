import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { buildSessionMiddleware } from "./auth/session.js";
import { loadUser } from "./middleware/auth.js";
import { apiRouter } from "./routes/index.js";
import { healthRouter } from "./routes/health-routes.js";
import { logger } from "./lib/logger.js";

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  // /health musí být dostupné bez session/DB závislosti na cookie.
  app.use(healthRouter);

  app.use(buildSessionMiddleware());
  app.use(loadUser);

  app.use("/api", apiRouter);

  // Chybový handler API.
  app.use("/api", (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Neošetřená chyba API", String(err));
    if (res.headersSent) return;
    res.status(500).json({ error: "Interní chyba serveru." });
  });

  return app;
}
