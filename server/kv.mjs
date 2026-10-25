/**
 * File-backed host.kv-compatible store.
 * Keys map 1:1 to design doc appendix B (colon-separated → nested path under data/kv).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function moduleDir() {
  // Demox uploads a CJS bundle where import.meta.url may be missing.
  const url = typeof import.meta !== "undefined" ? import.meta.url : "";
  if (!url) return path.resolve(process.cwd(), "server");
  try {
    return path.dirname(fileURLToPath(url));
  } catch {
    return path.resolve(process.cwd(), "server");
  }
}

let dataRoot = path.resolve(moduleDir(), "../data");

export function getDataRoot() {
  return dataRoot;
}

/** @deprecated use getDataRoot(); kept as live binding for scripts that import DATA_ROOT */
export let DATA_ROOT = dataRoot;
export let KV_ROOT = path.join(dataRoot, "kv");
export let BLOB_ROOT = path.join(dataRoot, "blobs");

/** Point MediaAccount KV at a directory (e.g. botcamp dataDir). Resets on each call. */
export function configureDataRoot(root) {
  dataRoot = path.resolve(root);
  DATA_ROOT = dataRoot;
  KV_ROOT = path.join(dataRoot, "kv");
  BLOB_ROOT = path.join(dataRoot, "blobs");
}

function keyToPath(key) {
  const safe = String(key).replace(/\.\./g, "").replace(/\\/g, "/");
  return path.join(KV_ROOT, ...safe.split(":")) + ".json";
}

export function ensureStoreDirs() {
  fs.mkdirSync(KV_ROOT, { recursive: true });
  fs.mkdirSync(path.join(BLOB_ROOT, "manuscripts"), { recursive: true });
}

export function kvGet(key) {
  const p = keyToPath(key);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function kvSet(key, value) {
  const p = keyToPath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", "utf8");
  return value;
}

export function kvDelete(key) {
  const p = keyToPath(key);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function writeBlob(relPath, content) {
  const p = path.join(BLOB_ROOT, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return `blobs/${relPath}`;
}

export function readBlob(relPath) {
  const clean = String(relPath).replace(/^blobs\//, "");
  const p = path.join(BLOB_ROOT, clean);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

export function listKvKeys(prefix = "") {
  const keys = [];
  function walk(dir, parts) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, [...parts, name]);
      else if (name.endsWith(".json")) {
        const key = [...parts, name.replace(/\.json$/, "")].join(":");
        if (!prefix || key.startsWith(prefix)) keys.push(key);
      }
    }
  }
  walk(KV_ROOT, []);
  return keys.sort();
}
