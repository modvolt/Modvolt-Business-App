import { getOpenAi } from "./openai-client.js";
import { env } from "../env.js";

// Chat, klasifikace i popis fotek běží přes OpenAI Responses API. Responses API
// je doporučené rozhraní pro modely řady GPT-5 (např. gpt-5.5) a plně podporuje
// strukturovaný JSON výstup i obrazové vstupy. Embeddingy sem NEPATŘÍ – počítají
// se zvlášť přes embeddings endpoint s embedding modelem (viz embeddings.ts).

/**
 * Zavolá model přes Responses API s vynuceným JSON výstupem (json_object).
 * Zachovává chování dřívějšího chat.completions s response_format json_object.
 * Vrací surový text odpovědi (očekává se platný JSON).
 */
export async function createJsonResponse(params: {
  system: string;
  user: string;
  model?: string;
}): Promise<string> {
  const res = await getOpenAi().responses.create({
    model: params.model ?? env.openai.chatModel,
    input: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
    text: { format: { type: "json_object" } },
  });
  return res.output_text ?? "";
}

/**
 * Popíše obrázek přes Responses API (textový pokyn + obrazový vstup).
 * Vrací volný text (ne JSON).
 */
export async function createVisionResponse(params: {
  system: string;
  userText: string;
  imageDataUrl: string;
  model?: string;
}): Promise<string> {
  const res = await getOpenAi().responses.create({
    model: params.model ?? env.openai.chatModel,
    input: [
      { role: "system", content: params.system },
      {
        role: "user",
        content: [
          { type: "input_text", text: params.userText },
          { type: "input_image", image_url: params.imageDataUrl, detail: "auto" },
        ],
      },
    ],
  });
  return res.output_text ?? "";
}
