import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSourceMode,
  sourceModeAllowsWeb,
  csnOnlyDocumentTypes,
} from "./source-mode.js";
import type { SourceMode } from "../../shared/types.js";

// Dotazy na elektrické normy / ČSN, které MUSÍ vynutit csn_only (žádný web).
const csnQueries: string[] = [
  "Co říká ČSN 33 2000-4-41 o ochraně?",
  "Jaká je norma pro revize elektroinstalace?",
  "Požadavky na proudový chránič (RCD)",
  "Výběr rozvaděče a jisticích prvků",
  "ČSN EN 60204-1",
  "IEC 60364 uzemnění a pospojování",
  "Výpočet impedance smyčky a zkratového proudu",
  "Soustava TN-C-S a dotykové napětí",
  "Měření izolačního odporu a revizní zpráva",
  "Vyhláška o vyhrazených technických zařízeních",
];

// Běžné, nenormové dotazy, kde musí zůstat požadovaný režim.
const nonCsnQueries: string[] = [
  "Jak nastavit firemní VPN?",
  "Postup schvalování dovolené",
  "Kontakt na obchodní oddělení",
];

const allRequested: SourceMode[] = [
  "internal_only",
  "internal_then_web",
  "web_allowed",
  "csn_only",
];

test("ČSN/norm queries always resolve to csn_only and are locked", () => {
  for (const q of csnQueries) {
    for (const requested of allRequested) {
      const d = resolveSourceMode(q, requested);
      assert.equal(d.sourceMode, "csn_only", `query: ${q} (req ${requested})`);
      assert.equal(d.locked, true, `query: ${q} (req ${requested})`);
    }
  }
});

test("ČSN/norm queries NEVER allow web search, even if web was requested", () => {
  for (const q of csnQueries) {
    // I když uživatel explicitně požádá o web_allowed, zámek to přebije.
    const d = resolveSourceMode(q, "web_allowed");
    assert.equal(d.sourceMode, "csn_only");
    assert.equal(
      sourceModeAllowsWeb(d.sourceMode),
      false,
      `web must be disabled for: ${q}`,
    );
  }
});

test("csn_only restricts retrieval to norm/standard document types", () => {
  assert.deepEqual(csnOnlyDocumentTypes().sort(), ["norm", "standard"]);
});

test("non-ČSN queries keep the requested mode (not locked)", () => {
  for (const q of nonCsnQueries) {
    for (const requested of allRequested) {
      const d = resolveSourceMode(q, requested);
      assert.equal(d.sourceMode, requested, `query: ${q}`);
      // csn_only requested zůstává csn_only, ale není to tvrdý zámek z obsahu.
      assert.equal(d.locked, false, `query: ${q}`);
    }
  }
});

test("sourceModeAllowsWeb only permits web for internal_then_web and web_allowed", () => {
  assert.equal(sourceModeAllowsWeb("internal_then_web"), true);
  assert.equal(sourceModeAllowsWeb("web_allowed"), true);
  assert.equal(sourceModeAllowsWeb("internal_only"), false);
  assert.equal(sourceModeAllowsWeb("csn_only"), false);
});
