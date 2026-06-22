// Sjednocené typované chyby nesoucí HTTP status a uživatelsky bezpečnou hlášku.
// Handlery je mohou vyhodit a centrální error handler (app.ts) z nich vytáhne
// správný status i konkrétní zprávu, místo paušálního „Interní chyba serveru.".
//
// `expose === true` znamená, že `message` je bezpečné ukázat uživateli (nejde
// o interní detail jako stack trace nebo connection string). Neočekávané chyby
// (bez tohoto příznaku) dostanou obecnou hlášku + identifikátor incidentu.

export class AppError extends Error {
  /** HTTP status, který má API vrátit klientovi. */
  status: number;
  /** True = `message` je uživatelsky bezpečná a smí se zobrazit klientovi. */
  expose: boolean;
  constructor(message: string, status = 500, expose = true) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.expose = expose;
  }
}

/** Chybný vstup / nesplněná podmínka požadavku → 400. */
export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
    this.name = "BadRequestError";
  }
}

/** Požadovaný záznam nenalezen → 404. */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

/** Konflikt stavu (duplicita, kolize verzí) → 409. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

/** Závislost (úložiště, AI) je nedostupná → 503. */
export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503);
    this.name = "ServiceUnavailableError";
  }
}

export interface DescribedError {
  status: number;
  message: string;
  /** True = známá/operační chyba (konkrétní hláška), false = neočekávaná. */
  expose: boolean;
}

/**
 * Odvodí HTTP status + bezpečnou hlášku z libovolné vyhozené hodnoty.
 * Operační chyby (AppError a potomci, případně jiné nesoucí číselný `status`
 * + `expose === true`) propustí svou konkrétní hlášku. Vše ostatní je
 * neočekávané → obecná hláška, kterou doplní volající o identifikátor incidentu.
 */
export function describeError(err: unknown): DescribedError {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; expose?: unknown; message?: unknown };
    if (
      typeof e.status === "number" &&
      e.expose === true &&
      typeof e.message === "string" &&
      e.message.length > 0
    ) {
      return { status: e.status, message: e.message, expose: true };
    }
  }
  return { status: 500, message: "Interní chyba serveru.", expose: false };
}
