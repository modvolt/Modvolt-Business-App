export interface Chunk {
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  content: string;
  tokenCount: number;
}

// Hrubý odhad tokenů (cca 4 znaky / token).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TARGET_CHARS = 3200; // ~800 tokenů
const OVERLAP_CHARS = 400; // ~100 tokenů překryv

/**
 * Rozdělí text na chunky s překryvem, respektuje odstavce a nadpisy.
 */
export function chunkText(
  fullText: string,
  pageNumber: number | null = null,
): Chunk[] {
  const normalized = fullText.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let buffer = "";
  let currentSection: string | null = null;
  let index = 0;

  const flush = () => {
    const content = buffer.trim();
    if (content.length > 0) {
      chunks.push({
        chunkIndex: index++,
        pageNumber,
        sectionTitle: currentSection,
        content,
        tokenCount: estimateTokens(content),
      });
    }
  };

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Detekce nadpisu (markdown nebo krátký řádek velkými písmeny).
    if (/^#{1,6}\s/.test(trimmed) || (trimmed.length < 80 && /^[A-ZČŠŽÁÉÍÓÚŮ0-9]/.test(trimmed) && !trimmed.includes("."))) {
      currentSection = trimmed.replace(/^#{1,6}\s/, "").slice(0, 200);
    }

    if (buffer.length + trimmed.length + 2 > TARGET_CHARS && buffer.length > 0) {
      flush();
      // Překryv: ponech konec předchozího bufferu.
      buffer = buffer.slice(-OVERLAP_CHARS);
    }
    buffer += (buffer ? "\n\n" : "") + trimmed;

    // Velmi dlouhý odstavec rozsekej tvrdě.
    while (buffer.length > TARGET_CHARS * 1.5) {
      const slice = buffer.slice(0, TARGET_CHARS);
      const content = slice.trim();
      chunks.push({
        chunkIndex: index++,
        pageNumber,
        sectionTitle: currentSection,
        content,
        tokenCount: estimateTokens(content),
      });
      buffer = buffer.slice(TARGET_CHARS - OVERLAP_CHARS);
    }
  }
  flush();
  return chunks;
}
