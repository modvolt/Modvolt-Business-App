import { createVisionResponse } from "../ai/openai-responses.js";
import { imageToDataUrl } from "./image-processing.js";
import { rasterizePdf } from "./pdf-rasterize.js";
import { env, isOcrUsable } from "../env.js";
import { logger } from "../lib/logger.js";

// Pokyn pro model: doslovný přepis textu ze skenu, bez komentářů a překladu.
const OCR_SYSTEM_PROMPT = `Jsi nástroj pro OCR (optické rozpoznávání textu) ve firmě Modvolt s.r.o. (elektroinstalace, slaboproud, revize, normy).
Dostaneš obrázek JEDNÉ naskenované stránky dokumentu. Přepiš VEŠKERÝ čitelný text doslovně a v pořadí, v jakém je na stránce.
PRAVIDLA:
- Zachovej původní jazyk (typicky čeština). NEPŘEKLÁDEJ.
- Zachovej odstavce a smysluplné řádkování. Zbytečně needituj formátování.
- NEKOMENTUJ, nic nevysvětluj, nepřidávej vlastní text ani nadpisy.
- Vrať POUZE přepsaný text. Pokud na stránce není žádný čitelný text, vrať prázdnou odpověď.`;

export interface OcrResult {
  fullText: string;
  /** Počet stran, ze kterých se podařilo získat text. */
  pageCount: number;
  /** Zda bylo PDF delší než limit stran a část se vynechala. */
  truncated: boolean;
}

/** OCR je dostupné, jen pokud je OpenAI použitelné a OCR je zapnuté. */
export function ocrAvailable(): boolean {
  return isOcrUsable();
}

/**
 * Provede OCR naskenovaného PDF: vykreslí stránky na obrázky a každou nechá
 * přepsat vision modelem. Stránky se zpracují postupně (šetří paměť i náklady
 * na malém stroji). Chyba jedné stránky neshodí celé OCR – jen se přeskočí.
 */
export async function ocrPdf(buffer: Buffer): Promise<OcrResult> {
  const maxPages = Math.max(1, env.openai.ocrMaxPages);
  const { pages, totalPages } = await rasterizePdf(buffer, maxPages);

  const texts: string[] = [];
  for (const page of pages) {
    try {
      const dataUrl = imageToDataUrl(page.jpeg);
      const raw = await createVisionResponse({
        system: OCR_SYSTEM_PROMPT,
        userText: "Přepiš veškerý text z této naskenované stránky.",
        imageDataUrl: dataUrl,
      });
      const text = raw.trim();
      if (text) texts.push(text);
    } catch (err) {
      logger.warn(`OCR stránky ${page.pageNumber} selhalo`, String(err));
    }
  }

  return {
    fullText: texts.join("\n\n"),
    pageCount: texts.length,
    truncated: totalPages > pages.length,
  };
}
