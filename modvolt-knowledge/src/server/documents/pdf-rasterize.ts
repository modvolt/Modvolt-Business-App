import sharp from "sharp";

// Maximální delší hrana výsledného obrázku stránky (px). Vyšší rozlišení
// zbytečně zvětšuje payload pro vision model bez přínosu pro čitelnost textu.
const MAX_DIMENSION = 2048;
// Měřítko renderu PDFium (2 = ~144 DPI u A4). Dostatečné pro OCR, přitom levné.
const RENDER_SCALE = 2;

export interface RasterizedPage {
  pageNumber: number;
  /** JPEG (grayscale) jedné stránky, zmenšený na MAX_DIMENSION. */
  jpeg: Buffer;
}

export interface RasterizeResult {
  pages: RasterizedPage[];
  /** Celkový počet stran v PDF (i když jich vykreslíme jen část). */
  totalPages: number;
}

/**
 * Vykreslí stránky PDF na grayscale JPEG obrázky pomocí PDFium (WASM).
 *
 * PDFium běží jako WebAssembly – nepotřebuje žádné systémové knihovny ani
 * apt-get balíčky (na rozdíl od node-canvas/cairo), takže image zůstává
 * přenositelný. Grayscale + JPEG drží payload pro vision model malý.
 *
 * Vykreslí nejvýše `maxPages` stran (ochrana nákladů a paměti na malém stroji).
 */
export async function rasterizePdf(
  buffer: Buffer,
  maxPages: number,
): Promise<RasterizeResult> {
  const { PDFiumLibrary } = await import("@hyzyla/pdfium");
  const library = await PDFiumLibrary.init();
  try {
    const doc = await library.loadDocument(new Uint8Array(buffer));
    try {
      const totalPages = doc.getPageCount();
      const limit = Math.min(totalPages, Math.max(1, maxPages));
      const pages: RasterizedPage[] = [];
      for (let i = 0; i < limit; i++) {
        const page = doc.getPage(i);
        const rendered = await page.render({
          scale: RENDER_SCALE,
          colorSpace: "Gray",
          render: async (o) => o.data,
        });
        const jpeg = await sharp(Buffer.from(rendered.data), {
          raw: {
            width: rendered.width,
            height: rendered.height,
            channels: 1,
          },
        })
          .resize({
            width: MAX_DIMENSION,
            height: MAX_DIMENSION,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 85 })
          .toBuffer();
        pages.push({ pageNumber: i + 1, jpeg });
      }
      return { pages, totalPages };
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}
