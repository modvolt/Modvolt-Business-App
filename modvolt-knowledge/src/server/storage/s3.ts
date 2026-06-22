import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { env, isS3Configured } from "../env.js";
import { logger } from "../lib/logger.js";
import { ServiceUnavailableError } from "../lib/errors.js";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!isS3Configured()) {
    throw new ServiceUnavailableError(
      "Úložiště souborů není nakonfigurováno.",
    );
  }
  if (!client) {
    client = new S3Client({
      endpoint: env.s3.endpoint,
      region: env.s3.region,
      forcePathStyle: env.s3.forcePathStyle,
      credentials: {
        accessKeyId: env.s3.accessKeyId,
        secretAccessKey: env.s3.secretAccessKey,
      },
    });
  }
  return client;
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }),
  );
  const stream = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }),
  );
}

/** Krátkodobé předpodepsané URL pro stažení (privátní bucket). */
export async function getDownloadUrl(
  key: string,
  expiresInSeconds = 300,
): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

export async function checkS3Health(): Promise<boolean> {
  if (!isS3Configured()) return false;
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: env.s3.bucket }));
    return true;
  } catch (err) {
    logger.warn("S3 health check selhal", String(err));
    return false;
  }
}
