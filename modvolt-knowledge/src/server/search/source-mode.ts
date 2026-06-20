import type { SourceMode } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Tvrdý zámek na režim "csn_only".
// Pro dotazy na elektrické normy / ČSN se NIKDY nesmí použít web.
//
// Spouštěč zámku má dvě části:
//  1) Vestavěné strukturální vzory (čísla norem, ČSN/EN/IEC s číslem) - ty
//     nelze rozumně vyjádřit jako prosté klíčové slovo, takže zůstávají v kódu
//     jako bezpečnostní základ a platí vždy.
//  2) Editovatelný seznam klíčových slov (admin panel -> nastavení
//     "csn_lock_keywords"). Čte se za běhu, takže změny se projeví bez
//     redeploye. Klíčová slova se porovnávají bez ohledu na velikost písmen a
//     diakritiku jako podřetězec - zadávejte kořeny slov (např. "norm",
//     "reviz"), aby se zachytily i různé pády.
// ---------------------------------------------------------------------------

// Vestavěné strukturální vzory (vždy aktivní bezpečnostní základ).
const BUILTIN_CSN_PATTERNS: RegExp[] = [
  /\biec\s*\d/i,
  /\ben\s*\d{4,}/i,
  /\b(33|50|73|34)\s?\d{3,}\b/, // typická čísla ČSN řad
];

// Výchozí editovatelná klíčová slova (kořeny slov, bez diakritiky se porovnává
// jako podřetězec). Tímto se seeduje nastavení "csn_lock_keywords".
export const DEFAULT_CSN_LOCK_KEYWORDS: string[] = [
  "csn",
  "norm",
  "reviz",
  "vyhlask",
  "narizeni vlady",
  "jisteni",
  "jistic",
  "zemneni",
  "uzemneni",
  "dimenzovani vodic",
  "dimenzovani kabel",
  "chranic",
  "rcd",
  "impedance smyck",
  "pospojovani",
  "ochrana pred urazem",
  "zivelna ochrana",
  "izolacni odpor",
  "elektroinstalac",
  "rozvadec",
  "prurez vodic",
  "prurez kabel",
  "zkratov",
  "vypinaci charakteristik",
  "tn-c",
  "tn-s",
  "it sit",
  "dotykove napeti",
];

export interface SourceModeDecision {
  sourceMode: SourceMode;
  locked: boolean;
  reason: string;
}

/** Odstraní diakritiku a převede na malá písmena pro tolerantní porovnání. */
function normalizeForMatch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Rozparsuje uložený text nastavení na seznam klíčových slov.
 * Oddělovač je nový řádek nebo čárka; prázdné položky se ignorují.
 */
export function parseCsnLockKeywords(
  raw: string | null | undefined,
): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Rozhodne efektivní režim zdrojů.
 * Pokud dotaz spadá pod elektrické normy/ČSN, vynutí "csn_only" bez ohledu
 * na požadovaný režim (tvrdý zámek) - žádný web, jen interní normové dokumenty.
 *
 * @param lockKeywords Editovatelná klíčová slova z nastavení. Pokud je seznam
 *   prázdný/nezadaný, použijí se výchozí (DEFAULT_CSN_LOCK_KEYWORDS).
 */
export function resolveSourceMode(
  query: string,
  requested: SourceMode,
  lockKeywords?: string[],
): SourceModeDecision {
  const normQuery = normalizeForMatch(query);
  const keywords =
    lockKeywords && lockKeywords.length > 0
      ? lockKeywords
      : DEFAULT_CSN_LOCK_KEYWORDS;

  const matchesKeyword = keywords.some((kw) => {
    const nk = normalizeForMatch(kw);
    return nk.length > 0 && normQuery.includes(nk);
  });
  const matchesBuiltin = BUILTIN_CSN_PATTERNS.some((re) => re.test(normQuery));

  if (matchesKeyword || matchesBuiltin) {
    return {
      sourceMode: "csn_only",
      locked: true,
      reason:
        "Dotaz se týká elektrických norem/ČSN. Z bezpečnostních důvodů se používají pouze interní normové dokumenty (žádný web).",
    };
  }

  return {
    sourceMode: requested,
    locked: false,
    reason: "Použit požadovaný režim zdrojů.",
  };
}

/** Smí daný režim používat web search? */
export function sourceModeAllowsWeb(mode: SourceMode): boolean {
  return mode === "internal_then_web" || mode === "web_allowed";
}

/** Smí daný režim používat interní dokumenty? Ano pro všechny aktuální režimy. */
export function sourceModeAllowsInternal(_mode: SourceMode): boolean {
  // Všechny současné režimy (internal_only, internal_then_web, web_allowed,
  // csn_only) preferují nebo dovolují interní dokumenty.
  return true;
}

/** Filtr typů dokumentů pro csn_only (jen normy/standardy). */
export function csnOnlyDocumentTypes(): string[] {
  return ["norm", "standard"];
}
