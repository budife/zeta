/**
 * Runs the pure-logic checks for the hand-frame pipeline (no browser, no
 * camera, no MediaPipe). Verifies gesture detection, frame fitting, face
 * selection, vector mapping and smoothing on synthetic landmarks.
 *
 * Usage: npm run test:logic
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const stage = path.join(os.tmpdir(), "hand-frame-vector-logic");

const libDir = path.join(root, "lib");
const testFile = path.join(root, "scripts", "test-logic.mts");

async function main() {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  // Node's TypeScript stripping needs explicit ".ts" in import specifiers, so
  // stage a copy of lib/ with the extension written in.
  const files = await readdir(libDir);
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const source = await readFile(path.join(libDir, file), "utf8");
    const rewritten = source.replace(
      /from "\.\/([a-zA-Z0-9_-]+)"/g,
      'from "./$1.ts"'
    );
    await writeFile(path.join(stage, file), rewritten);
  }

  const testSource = await readFile(testFile, "utf8");
  await writeFile(
    path.join(stage, "test-logic.mts"),
    testSource.replace(/from "\.\.\/lib\/([a-zA-Z0-9_-]+)"/g, 'from "./$1.ts"')
  );

  const child = spawn(process.execPath, ["test-logic.mts"], {
    cwd: stage,
    stdio: "inherit",
  });
  child.on("close", (code) => {
    if (code !== 0) {
      console.error(`\nLogic checks failed (exit ${code})`);
      process.exit(code ?? 1);
    }
    console.log("\nLogic checks completed.");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
