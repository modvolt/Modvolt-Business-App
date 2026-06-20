import type { Request, Response, NextFunction } from "express";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { SessionUser, UserRole } from "../../shared/types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: SessionUser;
    }
  }
}

export async function loadUser(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const userId = req.session?.userId;
  if (!userId) return next();
  try {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const u = rows[0];
    if (u && u.isActive) {
      req.currentUser = {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role as UserRole,
      };
    }
  } catch {
    // Ignoruj - request poběží jako nepřihlášený.
  }
  next();
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.currentUser) {
    return res.status(401).json({ error: "Vyžadováno přihlášení." });
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.currentUser) {
      return res.status(401).json({ error: "Vyžadováno přihlášení." });
    }
    if (!roles.includes(req.currentUser.role)) {
      return res.status(403).json({ error: "Nedostatečná oprávnění." });
    }
    next();
  };
}

/** read_only uživatelé nesmí provádět zápisové operace. */
export function requireWriteAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.currentUser) {
    return res.status(401).json({ error: "Vyžadováno přihlášení." });
  }
  if (req.currentUser.role === "read_only") {
    return res
      .status(403)
      .json({ error: "Účet pouze pro čtení nemá oprávnění k této akci." });
  }
  next();
}
