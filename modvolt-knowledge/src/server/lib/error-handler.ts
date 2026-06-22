// Centrální chybový handler API. Sem se díky `createRouter`/`asyncHandler`
// dostanou i odmítnuté Promise z asynchronních handlerů, takže selhání
// jednoho requestu vrátí chybu jen jemu a server běží dál.
//
// Známé/operační chyby (AppError a potomci nesoucí status + bezpečnou hlášku)
// propustí svou konkrétní zprávu i správný HTTP status. Neočekávané chyby
// dostanou obecnou hlášku doplněnou o krátký identifikátor incidentu, který se
// zaloguje spolu s detailem a stackem — díky tomu lze hlášku spárovat s logem.

import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { logger } from "./logger.js";
import { describeError } from "./errors.js";

export function apiErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const described = describeError(err);

  if (described.expose) {
    logger.warn("Operační chyba API", {
      method: req.method,
      path: req.originalUrl,
      status: described.status,
      message: err?.message ?? String(err),
    });
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(described.status).json({ error: described.message });
    return;
  }

  const incidentId = crypto.randomUUID().slice(0, 8);
  logger.error("Neošetřená chyba API", {
    incidentId,
    method: req.method,
    path: req.originalUrl,
    message: err?.message ?? String(err),
    stack: err?.stack,
  });
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({
    error: `Interní chyba serveru. (kód incidentu: ${incidentId})`,
    incidentId,
  });
}
