import { createRouter } from "../lib/async-router.js";
import { pool } from "../db/index.js";
import { checkS3Health } from "../storage/s3.js";
import {
  isOpenAiUsable,
  isVisionUsable,
  isWebSearchUsable,
  isS3Configured,
  APP_VERSION,
} from "../env.js";
import { webSearchAvailable } from "../search/web-search-service.js";

export const healthRouter = createRouter();

/**
 * Veřejný health endpoint — vrací jen minimum (status/version/time).
 * Neodhaluje vnitřní stav infrastruktury (DB, S3, OpenAI).
 * Používá ho Docker/Coolify healthcheck i monitoring.
 * Detailní checks jsou dostupné na GET /api/admin/system-health (vyžaduje admin).
 */
healthRouter.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const status = dbOk ? "ok" : "degraded";
  res.status(dbOk ? 200 : 503).json({
    status,
    version: APP_VERSION,
    time: new Date().toISOString(),
  });
});

/**
 * Interní health export — volá admin router pro GET /api/admin/system-health.
 * Odděleno, aby health-routes.ts zůstal bez session/auth závislostí.
 */
export async function collectSystemHealth() {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const s3Ok = isS3Configured() ? await checkS3Health() : false;
  return {
    status: dbOk ? "ok" : "degraded",
    version: APP_VERSION,
    time: new Date().toISOString(),
    checks: {
      database: dbOk,
      s3Configured: isS3Configured(),
      s3Reachable: s3Ok,
      openaiEnabled: isOpenAiUsable(),
      visionEnabled: isVisionUsable(),
      webSearchEnabled: isWebSearchUsable() && webSearchAvailable(),
    },
  };
}
