import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import crypto from "node:crypto";
import { buildSessionMiddleware } from "./auth/session.js";
import { loadUser } from "./middleware/auth.js";
import { apiRouter } from "./routes/index.js";
import { healthRouter } from "./routes/health-routes.js";
import { logger } from "./lib/logger.js";
import { describeError } from "./lib/errors.js";
import { env } from "./env.js";

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);

  // HTTP bezpečnostní hlavičky (Helmet).
  // HSTS jen v produkci (v dev by zablokoval http://localhost).
  app.use(
    helmet({
      hsts: env.isProduction
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
    }),
  );

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  // /health musí být dostupné bez session/DB závislosti na cookie.
  app.use(healthRouter);

  app.use(buildSessionMiddleware());
  app.use(loadUser);

  // Origin guard pro mutační API požadavky.
  // Blokuje cross-origin POST/PUT/PATCH/DELETE v produkci (nebo když je
  // nastaven APP_BASE_URL), aby cross-site formuláře nemohly zneužít session.
  // GET/HEAD/OPTIONS a požadavky bez Origin (server-to-server, curl) jsou
  // povoleny vždy. SameSite=lax cookie poskytuje základní ochranu, toto
  // je doplňková vrstva.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return next();

    const origin = req.get("origin");
    if (!origin) return next(); // server-to-server, curl — bez Origin povolíme

    const baseUrl = env.appBaseUrl;
    if (!env.isProduction && !baseUrl) return next(); // dev bez APP_BASE_URL

    const allowedHost = baseUrl
      ? (() => { try { return new URL(baseUrl).host; } catch { return null; } })()
      : req.hostname;

    if (!allowedHost) return next(); // nelze určit expected host

    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: "Požadavek odmítnut." });
    }

    if (originHost !== allowedHost) {
      logger.warn("Zamítnut cross-origin požadavek", {
        method,
        path: req.originalUrl,
        origin,
        expectedHost: allowedHost,
      });
      return res.status(403).json({ error: "Požadavek odmítnut: cizí origin." });
    }
    next();
  });

  app.use("/api", apiRouter);

  // Centrální chybový handler API. Sem se díky `createRouter`/`asyncHandler`
  // dostanou i odmítnuté Promise z asynchronních handlerů, takže selhání
  // jednoho requestu vrátí chybu jen jemu a server běží dál.
  //
  // Známé/operační chyby (AppError a potomci nesoucí status + bezpečnou hlášku)
  // propustí svou konkrétní zprávu i správný HTTP status. Neočekávané chyby
  // dostanou obecnou hlášku doplněnou o krátký identifikátor incidentu, který se
  // zaloguje spolu s detailem a stackem — díky tomu lze hlášku spárovat s logem.
  app.use("/api", (err: Error, req: Request, res: Response, next: NextFunction) => {
    const described = describeError(err);

    if (described.expose) {
      logger.warn("Operační chyba API", {
        method: req.method,
        path: req.originalUrl,
        status: described.status,
        message: err?.message ?? String(err),
      });
      if (res.headersSent) return next(err);
      return res.status(described.status).json({ error: described.message });
    }

    const incidentId = crypto.randomUUID().slice(0, 8);
    logger.error("Neošetřená chyba API", {
      incidentId,
      method: req.method,
      path: req.originalUrl,
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
    if (res.headersSent) return next(err);
    res.status(500).json({
      error: `Interní chyba serveru. (kód incidentu: ${incidentId})`,
      incidentId,
    });
  });

  return app;
}
