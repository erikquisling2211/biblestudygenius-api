/*
 * r2.js — upload files to Cloudflare R2 (S3-compatible object storage).
 * Wiring: imported by sermonprocess.js to host sermon audio for YouTube-only churches.
 * Env (set in Railway):
 *   R2_ENDPOINT           https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID      from the R2 API token
 *   R2_SECRET_ACCESS_KEY  from the R2 API token
 *   R2_BUCKET             e.g. bsg-sermons
 *   R2_PUBLIC_BASE        e.g. https://pub-xxxx.r2.dev
 * Requires: npm install @aws-sdk/client-s3
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { promises as fs } from "fs";

const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE } = process.env;

export function r2Configured() {
  return !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_BASE);
}

let _client = null;
function client() {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
  }
  return _client;
}

// Upload a local file to R2 under `key`; returns its public URL.
export async function uploadFileToR2(filePath, key, contentType = "application/octet-stream") {
  if (!r2Configured()) throw new Error("R2 not configured");
  const body = await fs.readFile(filePath);
  await client().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return `${R2_PUBLIC_BASE.replace(/\/$/, "")}/${key}`;
}
