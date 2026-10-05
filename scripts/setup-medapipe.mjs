/**
 * Setup script for MediaPipe runtime assets.
 *
 * 1. Copies the WASM runtime shipped inside node_modules/@mediapipe/tasks-vision
 *    into public/mediapipe/wasm so the app does not depend on a CDN at runtime.
 * 2. Downloads the Hand Landmarker + Face Landmarker model files into
 *    public/models when they are not present yet.
 *
 * Runs automatically on `npm install` (postinstall) and can be re-run with
 * `npm run setup:mediapipe`.
 */
import { cp, mkdir, readdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const WASM_SRC = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const WASM_DST = path.join(root, "public", "mediapipe", "wasm");

const MODELS_DIR = path.join(root, "public", "models");
const MODELS = [
  {
    file: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  },
  {
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  },
  {
    file: "pose_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  },
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyWasm() {
  if (!existsSync(WASM_SRC)) {
    console.warn(`[setup-medapipe] WASM source not found: ${WASM_SRC}`);
    console.warn(
      "[setup-medapipe] Falling back to the jsDelivr CDN at runtime (@mediapipe/tasks-vision wasm)."
    );
    return false;
  }
  await mkdir(WASM_DST, { recursive: true });
  await cp(WASM_SRC, WASM_DST, { recursive: true });
  const files = await readdir(WASM_DST);
  console.log(`[setup-medapipe] Copied ${files.length} wasm files -> public/mediapipe/wasm`);
  return true;
}

async function downloadModel({ file, url }) {
  const dest = path.join(MODELS_DIR, file);
  if (await exists(dest)) {
    console.log(`[setup-medapipe] Model already present: public/models/${file}`);
    return true;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(MODELS_DIR, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, buf);
    console.log(
      `[setup-medapipe] Downloaded public/models/${file} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`
    );
    return true;
  } catch (err) {
    console.warn(`[setup-medapipe] Could not download ${file}: ${err.message}`);
    console.warn(`[setup-medapipe] It will be fetched from the CDN at runtime instead.`);
    return false;
  }
}

const wasmOk = await copyWasm();
const results = await Promise.all(MODELS.map(downloadModel));

console.log(
  `[setup-medapipe] Done. wasm=${wasmOk ? "local" : "cdn"} models=${results.filter(Boolean).length}/${MODELS.length} local`
);
