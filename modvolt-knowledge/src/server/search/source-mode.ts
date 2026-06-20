import type { SourceMode } from "../../shared/types.js";

// Klíčová slova, která vynucují tvrdý zámek na režim "csn_only".
// Pro dotazy na elektrické normy / ČSN se NIKDY nesmí použít web.
const CSN_LOCK_PATTERNS: RegExp[] = [
  /\bČSN\b/i,
  /\bcsn\b/i,
  /\bČSN\s*EN\b/i,
  /\bIEC\s*\d/i,
  /\bEN\s*\d{4,}/i,
  /\bnorm(a|y|ě|ou|ám|ách|u)?\b/i,
  /\brevize?\b/i,
  /\brevizní\b/i,
  /\bvyhlášk[ay]\b/i,
  /\bnařízení vlády\b/i,
  /\b(33|50|73|34)\s?\d{3,}\b/, // typická čísla ČSN řad
  /\bjištění\b/i,
  /\bzemnění\b/i,
  /\bdimenzování (vodičů|kabelů)\b/i,
  /\bproudov(ý|ého|ém) chránič/i,
  /\bchránič(e|i|em)?\b/i,
  /\bRCD\b/i,
  /\bimpedance smyčky\b/i,
  /\buzemnění\b/i,
  /\bpospojování\b/i,
  /\bochrana před úrazem\b/i,
  /\bživelná ochrana\b/i,
  /\bizolačn(í|ího|ím) odpor/i,
  /\brevizní zpráv/i,
  /\belektroinstalac/i,
  /\brozvaděč/i,
  /\bjisti(č|če|čů|čem)\b/i,
  /\bprůřez (vodiče|kabelu)/i,
  /\bzkratov(ý|ého|á|é) proud/i,
  /\bvypínací charakteristik/i,
  /\bTN-(C|S|C-S)\b/i,
  /\bIT síť\b/i,
  /\bdotykové napětí\b/i,
];

export interface SourceModeDecision {
  sourceMode: SourceMode;
  locked: boolean;
  reason: string;
}

/**
 * Rozhodne efektivní režim zdrojů.
 * Pokud dotaz spadá pod elektrické normy/ČSN, vynutí "csn_only" bez ohledu
 * na požadovaný režim (tvrdý zámek) - žádný web, jen interní normové dokumenty.
 */
export function resolveSourceMode(
  query: string,
  requested: SourceMode,
): SourceModeDecision {
  const matchesCsn = CSN_LOCK_PATTERNS.some((re) => re.test(query));

  if (matchesCsn) {
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

/** Smí daný režim používat interní dokumenty? */
export function sourceModeAllowsInternal(mode: SourceMode): boolean {
  return mode !== "web_allowed" ? true : true; // web_allowed stále preferuje interní
}

/** Filtr typů dokumentů pro csn_only (jen normy/standardy). */
export function csnOnlyDocumentTypes(): string[] {
  return ["norm", "standard"];
}
