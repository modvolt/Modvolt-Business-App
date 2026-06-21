import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMultipartFilename } from "./filename.js";

test("opraví mojibake z multeru (latin1 dekódovaný UTF-8)", () => {
  const original = "Modulární systém IP interkomů Hikvision_manuál_CZ";
  const mojibake = Buffer.from(original, "utf8").toString("latin1");
  assert.equal(decodeMultipartFilename(mojibake), original);
});

test("už správný český název v UTF-8 nepoškodí", () => {
  const correct = "Konfigurační příručka_vnitřní monitory.pdf";
  assert.equal(decodeMultipartFilename(correct), correct);
});

test("čistě ASCII je identita", () => {
  const ascii = "plain_file-2.PDF";
  assert.equal(decodeMultipartFilename(ascii), ascii);
});

test("prázdný název vrací prázdný", () => {
  assert.equal(decodeMultipartFilename(""), "");
});

test("emoji / znaky mimo latin1 ponechá beze změny", () => {
  const name = "report_2026_✅.pdf";
  assert.equal(decodeMultipartFilename(name), name);
});
