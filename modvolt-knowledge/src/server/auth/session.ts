import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../db/index.js";
import { env } from "../env.js";

const PgStore = connectPgSimple(session);

export function buildSessionMiddleware() {
  return session({
    store: new PgStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    name: "modvolt.sid",
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 dní
    },
  });
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}
