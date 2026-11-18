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
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
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

/** Public URL for an R2 key (bucket is served via R2_PUBLIC_BASE). */
export function r2PublicUrl(key) {
  return `${String(R2_PUBLIC_BASE || "").replace(/\/$/, "")}/${key}`;
}

/** True if an object exists at `key` (HEAD request; no bytes transferred). */
export async function r2Exists(key) {
  if (!r2Configured()) throw new Error("R2 not configured");
  try {
    await client().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode;
    if (code === 404 || e?.name === "NotFound" || e?.name === "NoSuchKey") return false;
    throw e;
  }
}

/** List keys under a prefix (paginated). */
export async function r2ListKeys(prefix) {
  if (!r2Configured()) throw new Error("R2 not configured");
  const keys = [];
  let token;
  do {
    const r = await client().send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// Upload a local file to R2 under `key`; returns its public URL.
export async function uploadFileToR2(filePath, key, contentType = "application/octet-stream") {
  if (!r2Configured()) throw new Error("R2 not configured");
  const body = await fs.readFile(filePath);
  await client().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return `${R2_PUBLIC_BASE.replace(/\/$/, "")}/${key}`;
}
