import express, { type RequestHandler, type Router } from "express";

// V Expressu 4 odmítnutý (rejected) Promise vrácený z route handleru NEpropadne
// do error middleware – stane se z něj unhandledRejection, který shodí celý
// proces. `asyncHandler` to ošetří: zachytí odmítnutí a předá ho do `next(err)`,
// takže selhání jednoho requestu vrátí chybu jen tomu jednomu requestu a server
// běží dál.
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Metody, jejichž handlery obalujeme. `use` záměrně vynecháváme – Express
// rozpoznává error middleware podle počtu argumentů (4) a obalení by to rozbilo;
// navíc middleware registrovaná přes `use` jsou v této aplikaci synchronní.
const ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "all"] as const;

// Vytvoří Router, jehož všechny route handlery jsou automaticky obalené
// `asyncHandler`em. Díky tomu nemusí každý handler řešit try/catch a žádné
// odmítnuté DB/IO volání neshodí server.
export function createRouter(): Router {
  const router = express.Router();
  const mutable = router as unknown as Record<
    string,
    (path: unknown, ...handlers: RequestHandler[]) => Router
  >;
  for (const method of ROUTE_METHODS) {
    const original = mutable[method].bind(router);
    mutable[method] = (path: unknown, ...handlers: RequestHandler[]) =>
      original(path, ...handlers.map(asyncHandler));
  }
  return router;
}
