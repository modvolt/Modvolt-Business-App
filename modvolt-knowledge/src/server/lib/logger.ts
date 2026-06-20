import { env } from "../env.js";

const LEVELS: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const threshold = LEVELS[env.logLevel] ?? 2;

function log(level: string, msg: string, meta?: unknown) {
  if ((LEVELS[level] ?? 2) > threshold) return;
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] ${msg}`;
  if (meta !== undefined) {
    console.log(base, typeof meta === "string" ? meta : JSON.stringify(meta));
  } else {
    console.log(base);
  }
}

export const logger = {
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  debug: (msg: string, meta?: unknown) => log("debug", msg, meta),
};
