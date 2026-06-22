import { getOpenAi } from "./openai-client.js";
import { env, isVisionUsable } from "../env.js";
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
  const res = await getOpenAi().chat.completions.create({
    model: env.openai.chatModel,
    messages: [
      {
        role: "system",
        content:
          "Jsi technik elektro. Popiš pouze to, co je na fotografii skutečně vidět (zařízení, štítky, zapojení, viditelné závady). Neodhaduj hodnoty, které nelze z fotografie bezpečně určit. Odpovídej česky, stručně, v odrážkách.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Popiš tuto fotografii z pohledu elektrotechnika." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}
