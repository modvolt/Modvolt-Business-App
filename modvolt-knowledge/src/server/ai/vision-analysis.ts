import { createVisionResponse } from "./openai-responses.js";
import { isVisionUsable } from "../env.js";
import { imageToDataUrl } from "../documents/image-processing.js";
import { ServiceUnavailableError } from "../lib/errors.js";

export function visionAvailable(): boolean {
  return isVisionUsable();
}

/**
 * Popíše, co je na fotografii vidět (bez odhadování neměřitelných hodnot).
 * Vrací stručný textový popis použitelný jako kontext pro chat.
 */
export async function describeImage(imageBuffer: Buffer): Promise<string> {
  if (!visionAvailable()) {
    throw new ServiceUnavailableError("Analýza obrazu není dostupná.");
  }
  const dataUrl = imageToDataUrl(imageBuffer);
  const text = await createVisionResponse({
    system:
      "Jsi technik elektro. Popiš pouze to, co je na fotografii skutečně vidět (zařízení, štítky, zapojení, viditelné závady). Neodhaduj hodnoty, které nelze z fotografie bezpečně určit. Odpovídej česky, stručně, v odrážkách.",
    userText: "Popiš tuto fotografii z pohledu elektrotechnika.",
    imageDataUrl: dataUrl,
  });
  return text.trim();
}
