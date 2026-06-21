/**
 * multer/busboy dekóduje název souboru z multipart/form-data jako latin1,
 * takže UTF-8 názvy s diakritikou se rozsypou ("Modulární" -> "ModulÃ¡rnÃ­").
 * Tato funkce překódováním latin1 -> utf8 obnoví správné znaky.
 *
 * Ochrany proti poškození už správného názvu:
 *  - znak mimo rozsah latin1 (0–255) značí, že řetězec je už korektní Unicode
 *    (multer by takový nevrátil) → ponecháme beze změny;
 *  - pokud překódování zavede náhradní znak U+FFFD (původní bajty nebyly platné
 *    UTF-8, tj. nešlo o mojibake) → ponecháme původní název.
 *
 * Pro čistě ASCII je výsledek identita.
 */
export function decodeMultipartFilename(name: string): string {
  if (!name) return name;
  if (/[^\u0000-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  if (decoded.includes("\uFFFD")) return name;
  return decoded;
}
