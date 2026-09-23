import * as faceapi from "@vladmandic/face-api";

const MODEL_URL = "/models";
const MAX_PHOTO_SIDE = 640;
const detectorOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });

export interface DetectedFace {
  box: { x: number; y: number; width: number; height: number };
  score: number;
  descriptor: number[];
}

let loading: Promise<void> | null = null;

/** Safe to call from anywhere: every caller shares one load, and a failed load can be retried. */
export function loadModels(): Promise<void> {
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

async function load(): Promise<void> {
  // tf.ready() exists at runtime; face-api's bundled typings leave it out.
  await (faceapi.tf as unknown as { ready(): Promise<void> }).ready();
  const nets = [
    faceapi.nets.ssdMobilenetv1,
    faceapi.nets.faceLandmark68Net,
    faceapi.nets.faceRecognitionNet,
  ];
  await Promise.all(nets.filter((net) => !net.isLoaded).map((net) => net.loadFromUri(MODEL_URL)));
}

export async function detectFaces(
  input: HTMLVideoElement | HTMLCanvasElement,
): Promise<DetectedFace[]> {
  const results = await faceapi
    .detectAllFaces(input, detectorOptions)
    .withFaceLandmarks()
    .withFaceDescriptors();
  // A face print with NaN in it (e.g. from degraded GPU float precision) compares as neither near
  // nor far, so it could never be judged fairly — drop the face rather than risk a wrong name.
  return results
    .filter(({ descriptor }) => descriptor.every(Number.isFinite))
    .map(({ detection, descriptor }) => ({
      box: {
        x: detection.box.x,
        y: detection.box.y,
        width: detection.box.width,
        height: detection.box.height,
      },
      score: detection.score,
      descriptor: Array.from(descriptor),
    }));
}

/**
 * For a still photo. The detector learned faces in context and misses one that fills the whole
 * frame (a tight selfie crop), so when nothing is found, look again with a border around it.
 */
export async function detectPhotoFaces(photo: HTMLCanvasElement): Promise<DetectedFace[]> {
  const faces = await detectFaces(photo);
  if (faces.length > 0) return faces;
  const padX = Math.round(photo.width / 2);
  const padY = Math.round(photo.height / 2);
  const framed = document.createElement("canvas");
  framed.width = photo.width + 2 * padX;
  framed.height = photo.height + 2 * padY;
  const ctx = framed.getContext("2d");
  if (!ctx) return faces;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, framed.width, framed.height);
  ctx.drawImage(photo, padX, padY);
  return (await detectFaces(framed)).map((face) => ({
    ...face,
    box: { ...face.box, x: face.box.x - padX, y: face.box.y - padY },
  }));
}

/**
 * Decodes the file onto a canvas no larger than MAX_PHOTO_SIDE. Detect on this canvas AND store
 * this canvas, so the saved photo is exactly what the descriptor was computed from.
 */
export async function loadPhoto(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't draw images.");
    // JPEG has no transparency: flatten onto white now so detection sees what gets stored.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
