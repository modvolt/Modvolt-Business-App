import sharp from "sharp";
import { env } from "../env.js";

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: string;
  exifRemoved: boolean;
}

const MAX_DIMENSION = 2048;

/**
 * Zpracuje nahranou fotografii: zmenší a (povinně) odstraní EXIF metadata.
 * sharp ve výchozím stavu metadata nezachovává -> EXIF (vč. GPS) je odstraněn.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const pipeline = sharp(input, { failOn: "none" })
    .rotate() // aplikuje orientaci dle EXIF, pak EXIF zahodí
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });

  // Bez .withMetadata() => metadata (EXIF, GPS) nejsou zapsána.
  const output = await pipeline.jpeg({ quality: 85 }).toBuffer({
    resolveWithObject: true,
  });

  return {
    buffer: output.data,
    width: output.info.width,
    height: output.info.height,
    mimeType: "image/jpeg",
    exifRemoved: env.image.stripExif,
  };
}

export function imageToDataUrl(buffer: Buffer, mimeType = "image/jpeg"): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
