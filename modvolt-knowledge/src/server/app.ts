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

  // Centrální chybový handler API. Sem se díky `createRouter`/`asyncHandler`
  // dostanou i odmítnuté Promise z asynchronních handlerů, takže selhání
  // jednoho requestu vrátí 500 jen jemu a server běží dál.
  app.use("/api", (err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error("Neošetřená chyba API", {
      method: req.method,
      path: req.originalUrl,
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Interní chyba serveru." });
  });

  return app;
}
