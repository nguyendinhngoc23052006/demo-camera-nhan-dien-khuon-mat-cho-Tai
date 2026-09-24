import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const opencv = join(root, "node_modules", "@techstark", "opencv-js", "dist", "opencv.js");
// LiteRT's wasm runtime (the depth model's engine), pinned by the exact version in package.json.
const litert = join(root, "node_modules", "@litertjs", "core", "wasm");

// source → destination under public/, with the SHA-256 the face thresholds were calibrated on.
const FILES = [
  [
    join(root, "models", "face_detection_yunet_2023mar.onnx"),
    "models/face_detection_yunet_2023mar.onnx",
    "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  ],
  [
    join(root, "models", "face_recognition_sface_2021dec_int8bq.onnx"),
    "models/face_recognition_sface_2021dec_int8bq.onnx",
    "fb143eea07838aa532d1c95df5f69899974ea0140e1fba05e94204be13ed74ee",
  ],
  [opencv, "vendor/opencv.js", "bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103"],
  // Depth Anything V2 Small at 266 px, fp16 TFLite, split to stay under Cloudflare's 25 MiB limit.
  [
    join(root, "models", "dav2_266_f16.part0"),
    "models/dav2_266_f16.part0",
    "6c674256be865f116d3eb6b40a5a7850d9e61d3a5f881c220c0904d13352f40a",
  ],
  [
    join(root, "models", "dav2_266_f16.part1"),
    "models/dav2_266_f16.part1",
    "b7af9cbd79fafff28e8168d4e079fd28522a25f8209718f45bf397efd2e133ed",
  ],
];

const problems = [];
for (const [from, , sha] of FILES) {
  if (!existsSync(from)) problems.push(`missing: ${from}`);
  else if (createHash("sha256").update(readFileSync(from)).digest("hex") !== sha) {
    problems.push(`changed: ${from} (SHA-256 differs from the calibrated file)`);
  }
}
if (!existsSync(litert)) problems.push(`missing: ${litert}`);
if (problems.length > 0) {
  console.error(
    `copy-models:\n  ${problems.join("\n  ")}\nRun "npm ci"; model files live in models/.`,
  );
  process.exit(1);
}

for (const [from, to] of FILES) {
  const dest = join(root, "public", to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(from, dest);
}
cpSync(litert, join(root, "public", "vendor", "litert"), { recursive: true });
console.log(
  `copy-models: verified and copied ${FILES.length} files and the LiteRT runtime to public/`,
);
