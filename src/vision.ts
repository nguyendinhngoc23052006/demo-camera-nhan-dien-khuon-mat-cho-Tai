// OpenCV in the browser: YuNet finds faces, SFace turns each one into a 128-number face print.
// opencv.js has no FaceRecognizerSF binding, so its align-and-crop step is ported below.

const OPENCV_URL = "/vendor/opencv.js";
const YUNET_URL = "/models/face_detection_yunet_2023mar.onnx";
const SFACE_URL = "/models/face_recognition_sface_2021dec_int8bq.onnx";
const MAX_PHOTO_SIDE = 640;
const DETECT_SCORE = 0.6;
const NMS = 0.3;
const TOP_K = 5000;

export interface DetectedFace {
  box: { x: number; y: number; width: number; height: number };
  score: number;
  descriptor: number[];
}

// The slice of the opencv.js API this file uses; the package's own typings omit FaceDetectorYN.
interface Mat {
  rows: number;
  data32F: Float32Array;
  delete(): void;
}
interface Net {
  setInput(blob: Mat): void;
  forward(): Mat;
}
interface FaceDetectorYN {
  setInputSize(size: unknown): void;
  detect(image: Mat, faces: Mat): void;
}
interface OpenCV {
  Mat: new () => Mat;
  Size: new (w: number, h: number) => unknown;
  Scalar: new (a: number, b: number, c: number) => unknown;
  CV_64F: number;
  COLOR_RGBA2BGR: number;
  INTER_LINEAR: number;
  imread(canvas: HTMLCanvasElement): Mat;
  cvtColor(src: Mat, dst: Mat, code: number): void;
  matFromArray(rows: number, cols: number, type: number, data: number[]): Mat;
  warpAffine(src: Mat, dst: Mat, m: Mat, size: unknown, flags: number): void;
  blobFromImage(
    image: Mat,
    scale: number,
    size: unknown,
    mean: unknown,
    swapRB: boolean,
    crop: boolean,
  ): Mat;
  readNetFromONNX(path: string): Net;
  FaceDetectorYN: new (
    model: string,
    config: string,
    size: unknown,
    score: number,
    nms: number,
    topK: number,
  ) => FaceDetectorYN;
  FS_createDataFile(
    dir: string,
    name: string,
    data: Uint8Array,
    read: boolean,
    write: boolean,
    own: boolean,
  ): void;
  onRuntimeInitialized?: () => void;
}

let cv: OpenCV;
let detector: FaceDetectorYN;
let recognizer: Net;
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
  if (!cv) await loadOpenCV();
  const [yunet, sface] = await Promise.all([fetchBytes(YUNET_URL), fetchBytes(SFACE_URL)]);
  writeFile("yunet.onnx", yunet);
  writeFile("sface.onnx", sface);
  detector = new cv.FaceDetectorYN(
    "yunet.onnx",
    "",
    new cv.Size(320, 320),
    DETECT_SCORE,
    NMS,
    TOP_K,
  );
  recognizer = cv.readNetFromONNX("sface.onnx");
}

function writeFile(name: string, data: Uint8Array): void {
  try {
    cv.FS_createDataFile("/", name, data, true, false, false);
  } catch {
    // Already written by an earlier attempt that failed later on.
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Assigns `cv` rather than returning it: an async function returning the Emscripten module would
// unwrap its self-resolving `then` forever and freeze the page.
async function loadOpenCV(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = OPENCV_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`${OPENCV_URL} failed to load`));
    document.head.append(script);
  });
  const loaded = (window as unknown as { cv: OpenCV | Promise<OpenCV> }).cv;
  const module = loaded instanceof Promise ? await loaded : loaded;
  if (!(module as Partial<OpenCV>).Mat) {
    await new Promise<void>((resolve) => {
      module.onRuntimeInitialized = resolve;
    });
  }
  cv = module;
}

export async function detectFaces(input: HTMLCanvasElement): Promise<DetectedFace[]> {
  const rgba = cv.imread(input);
  const bgr = new cv.Mat();
  const found = new cv.Mat();
  try {
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    detector.setInputSize(new cv.Size(input.width, input.height));
    detector.detect(bgr, found);
    const faces: DetectedFace[] = [];
    for (let i = 0; i < found.rows; i++) {
      // Each row: x, y, w, h, then 5 landmarks (eyes, nose tip, mouth corners) as x/y, then score.
      const r = Array.from(found.data32F.subarray(i * 15, i * 15 + 15));
      const landmarks = [0, 1, 2, 3, 4].map((k) => [r[4 + 2 * k] ?? 0, r[5 + 2 * k] ?? 0]);
      const descriptor = faceprint(bgr, landmarks);
      // A face print with NaN in it compares as neither near nor far — drop the face.
      if (!descriptor.every(Number.isFinite)) continue;
      faces.push({
        box: { x: r[0] ?? 0, y: r[1] ?? 0, width: r[2] ?? 0, height: r[3] ?? 0 },
        score: r[14] ?? 0,
        descriptor,
      });
    }
    return faces;
  } finally {
    rgba.delete();
    bgr.delete();
    found.delete();
  }
}

function faceprint(bgr: Mat, landmarks: number[][]): number[] {
  const m = cv.matFromArray(2, 3, cv.CV_64F, similarityTransform(landmarks));
  const aligned = new cv.Mat();
  let blob: Mat | null = null;
  let out: Mat | null = null;
  try {
    cv.warpAffine(bgr, aligned, m, new cv.Size(112, 112), cv.INTER_LINEAR);
    blob = cv.blobFromImage(aligned, 1, new cv.Size(112, 112), new cv.Scalar(0, 0, 0), true, false);
    recognizer.setInput(blob);
    out = recognizer.forward();
    return Array.from(out.data32F);
  } finally {
    m.delete();
    aligned.delete();
    blob?.delete();
    out?.delete();
  }
}

// SFace's 112x112 reference positions for the 5 landmarks, and OpenCV's hard-coded mean of them.
const REFERENCE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
const REFERENCE_MEAN = [56.0262, 71.9008];

/**
 * Port of OpenCV's FaceRecognizerSFImpl::getSimilarityTransformMatrix (objdetect, face_recognize.cpp):
 * the rotation + scale + shift that best moves the detected landmarks onto REFERENCE (Umeyama).
 * Returns a 2x3 affine matrix, row-major.
 */
export function similarityTransform(src: number[][]): number[] {
  const at = (p: number[] | undefined, i: number) => p?.[i] ?? 0;
  const mean = [0, 1].map((i) => src.reduce((sum, p) => sum + at(p, i), 0) / 5);
  const s = src.map((p) => [at(p, 0) - at(mean, 0), at(p, 1) - at(mean, 1)]);
  const d = REFERENCE.map((p) => [
    at(p, 0) - at(REFERENCE_MEAN, 0),
    at(p, 1) - at(REFERENCE_MEAN, 1),
  ]);
  let a00 = 0;
  let a01 = 0;
  let a10 = 0;
  let a11 = 0;
  for (let i = 0; i < 5; i++) {
    a00 += at(d[i], 0) * at(s[i], 0);
    a01 += at(d[i], 0) * at(s[i], 1);
    a10 += at(d[i], 1) * at(s[i], 0);
    a11 += at(d[i], 1) * at(s[i], 1);
  }
  a00 /= 5;
  a01 /= 5;
  a10 /= 5;
  a11 /= 5;
  const reflect = a00 * a11 - a01 * a10 < 0 ? -1 : 1;

  // 2x2 SVD as rotation(phi) · diag(s0, s1) · rotation(theta).
  const e = (a00 + a11) / 2;
  const f = (a00 - a11) / 2;
  const g = (a10 + a01) / 2;
  const h = (a10 - a01) / 2;
  const q = Math.hypot(e, h);
  const r = Math.hypot(f, g);
  const s0 = q + r;
  let s1 = q - r;
  const t1 = Math.atan2(g, f);
  const t2 = Math.atan2(h, e);
  const theta = (t2 - t1) / 2;
  const phi = (t2 + t1) / 2;
  const u = [Math.cos(phi), -Math.sin(phi), Math.sin(phi), Math.cos(phi)];
  const vt = [Math.cos(theta), -Math.sin(theta), Math.sin(theta), Math.cos(theta)];
  if (s1 < 0) {
    s1 = -s1;
    vt[2] = -(vt[2] as number);
    vt[3] = -(vt[3] as number);
  }
  const [u0 = 0, u1 = 0, u2 = 0, u3 = 0] = u;
  const [v0 = 0, v1 = 0, v2 = 0, v3 = 0] = vt;
  // T = U · diag(1, reflect) · Vt
  const t = [
    u0 * v0 + u1 * reflect * v2,
    u0 * v1 + u1 * reflect * v3,
    u2 * v0 + u3 * reflect * v2,
    u2 * v1 + u3 * reflect * v3,
  ];
  const variance = s.reduce((sum, p) => sum + at(p, 0) ** 2 + at(p, 1) ** 2, 0) / 5;
  const scale = (s0 + s1 * reflect) / variance;
  const [t0 = 0, tb = 0, tc = 0, td = 0] = t;
  const [m0 = 0, m1 = 0] = mean;
  const [r0 = 0, r1 = 0] = REFERENCE_MEAN;
  return [
    t0 * scale,
    tb * scale,
    r0 - scale * (t0 * m0 + tb * m1),
    tc * scale,
    td * scale,
    r1 - scale * (tc * m0 + td * m1),
  ];
}

/**
 * For a still photo. A face that fills the whole frame is easy to miss without background, so
 * when nothing is found, look again with a border around it.
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
