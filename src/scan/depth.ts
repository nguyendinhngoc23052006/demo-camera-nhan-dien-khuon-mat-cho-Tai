// The only file that touches LiteRT (TensorFlow Lite for the web). Estimates relative depth from
// one camera image with Depth Anything V2 Small (Apache-2.0) at 266×266, for phones whose AR has
// no depth sensing. The output is inverse depth up to an unknown scale and shift; align.ts turns it
// into metres using distances the phone measured.
import { type CompiledModel, loadAndCompile, loadLiteRt, Tensor } from "@litertjs/core";

export const DEPTH_SIZE = 266;
// Split because Cloudflare Pages serves files up to 25 MiB; checksums are verified at build time.
const PARTS = ["/models/dav2_266_f16.part0", "/models/dav2_266_f16.part1"];
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let loading: Promise<CompiledModel> | null = null;

/** Loads the runtime and model once; a failed load can be retried. */
export function loadDepthModel(): Promise<CompiledModel> {
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

async function load(): Promise<CompiledModel> {
  // Threads need cross-origin isolation (COOP + COEP headers, see public/_headers).
  await loadLiteRt("/vendor/litert/", { threads: self.crossOriginIsolated === true });
  const parts = await Promise.all(
    PARTS.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return loadAndCompile(bytes, { accelerator: "wasm" });
}

/**
 * Relative inverse depth (bigger = nearer) for an RGBA image, as DEPTH_SIZE × DEPTH_SIZE values in
 * row-major order, top row first. The image is stretched to a square, as the model was trained.
 * `flipY` turns the image upside down first (for pixels read back bottom row first).
 */
export async function estimateInverseDepth(
  image: ImageData,
  flipY: boolean,
): Promise<Float32Array> {
  const model = await loadDepthModel();
  const size = DEPTH_SIZE;
  const bitmap = await createImageBitmap(image, {
    imageOrientation: flipY ? "flipY" : "from-image",
  });
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't draw images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, size, size).data;
  const input = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) {
      input[i * 3 + c] =
        ((pixels[i * 4 + c] as number) / 255 - (MEAN[c] as number)) / (STD[c] as number);
    }
  }
  const tensor = new Tensor(input, [1, size, size, 3]);
  try {
    const outputs = await model.run(tensor);
    const result = Float32Array.from(outputs[0]?.toTypedArray() ?? []);
    for (const output of outputs) output.delete();
    return result;
  } finally {
    tensor.delete();
  }
}
