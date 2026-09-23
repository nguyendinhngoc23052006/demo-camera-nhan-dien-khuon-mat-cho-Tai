import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@vladmandic", "face-api", "model");
const to = join(root, "public", "models");

const FILES = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model.bin",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model.bin",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model.bin",
];

const missing = FILES.filter((file) => !existsSync(join(from, file)));
if (missing.length > 0) {
  console.error(
    `copy-models: missing in ${from}:\n  ${missing.join("\n  ")}\nRun "npm ci" and check that @vladmandic/face-api is installed.`,
  );
  process.exit(1);
}

mkdirSync(to, { recursive: true });
for (const file of FILES) copyFileSync(join(from, file), join(to, file));
console.log(`copy-models: copied ${FILES.length} files to public/models`);
