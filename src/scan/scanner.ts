// The only file that touches WebXR. Runs an immersive-ar session and turns what the phone
// measures into voxels (see map.ts), with a live preview over the camera image. Two sources:
// - "depth": CPU depth maps, on phones whose ARCore supports depth (the full room shape);
// - "surfaces": a grid of hit-test rays against the flat surfaces ARCore detects (floor, walls,
//   tables) — every ARCore phone can do this, depth or not. When the phone is held still, a
//   camera snapshot goes through a depth model (depth.ts) scaled by those hits (align.ts), which
//   fills in chairs and anything else that isn't flat.
// Only the room's shape is kept — never camera images — and only in memory.
import {
  BufferGeometry,
  Float32BufferAttribute,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  WebGLRenderer,
} from "three";
import { type Snapshot, snapshotPoints } from "./align";
import {
  invert,
  MAX_TURN_RATE,
  MAX_VOXELS,
  MIN_HITS,
  type RoomScan,
  type ScanMode,
  turnAngle,
  unproject,
  type Vec3,
  VOXEL_SIZE,
  VoxelMap,
  voxelCentre,
  voxelOf,
} from "./map";

/** Depth samples per frame (columns × rows) — plenty for 5 cm voxels at room distances. */
const SAMPLE_COLS = 40;
const SAMPLE_ROWS = 30;
/** Read depth every Nth frame; the phone's depth map updates slower than the screen anyway. */
const DEPTH_EVERY = 3;
/** Record the walked path each time the phone moves this far, metres. */
const PATH_STEP = 0.2;
/** Hit-test rays (columns × rows) and their spread from the view centre, degrees. */
const RAY_COLS = 5;
const RAY_ROWS = 4;
const RAY_SPREAD_X = 25;
const RAY_SPREAD_Y = 30;
/** A snapshot is taken after the phone turns slower than this (°/s) for this many frames. */
const STILL_RATE = 10;
const STILL_FRAMES = 30;
/** At most one snapshot per this many milliseconds. */
const SNAPSHOT_EVERY_MS = 1500;
/** Hit points younger than this (ms) are used to scale a snapshot. */
const RECENT_HITS_MS = 2500;

/**
 * "unaligned": the last snapshot couldn't be scaled — the measured points in view were all at one
 * distance (e.g. facing a bare wall). "unavailable": this phone gives no camera image or the model
 * didn't load; surfaces still work. "covered": the one-spot scan already has this direction.
 */
export type SnapshotState =
  | "off"
  | "loading"
  | "ready"
  | "measuring"
  | "unaligned"
  | "unavailable"
  | "covered";

export interface ScanProgress {
  mode: ScanMode;
  snapshots: number;
  snapshotState: SnapshotState;
  voxels: number;
  tracking: boolean;
  /** Turning too fast for depth to line up; the UI asks to slow down. */
  tooFast: boolean;
  full: boolean;
}

// Minimal WebXR typings for the parts used here (lib.dom does not ship WebXR).
interface XRDepthInfo {
  getDepthInMeters(x: number, y: number): number;
}
interface XRViewLike {
  projectionMatrix: Float32Array;
  transform: { matrix: Float32Array; position: DOMPointReadOnly };
  camera?: { width: number; height: number } | null;
}
interface XRBindingLike {
  getCameraImage(camera: object): WebGLTexture | null;
}
interface XRFrameLike {
  getViewerPose(space: unknown): { views: readonly XRViewLike[]; emulatedPosition: boolean } | null;
  getDepthInformation(view: XRViewLike): XRDepthInfo | null;
  getHitTestResults(source: unknown): { getPose(space: unknown): XRViewLike | null }[];
}
interface XRSessionLike extends EventTarget {
  enabledFeatures?: readonly string[];
  end(): Promise<void>;
  requestReferenceSpace(type: string): Promise<unknown>;
  requestHitTestSource(options: { space: unknown; offsetRay: unknown }): Promise<unknown>;
}
type XRRayConstructor = new (origin: DOMPointInit, direction: DOMPointInit) => unknown;
interface XRSystemLike {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init: object): Promise<XRSessionLike>;
}

function xr(): XRSystemLike | undefined {
  return (navigator as Navigator & { xr?: XRSystemLike }).xr;
}

export async function canScan(): Promise<boolean> {
  try {
    return (await xr()?.isSessionSupported("immersive-ar")) === true;
  } catch {
    return false;
  }
}

let active: XRSessionLike | null = null;

/** Ends the running scan; the promise from startScan then resolves with the result. */
export function finishScan(): void {
  void active?.end();
}

/** The AR session started, but the phone can neither measure depth nor detect surfaces. */
export class CannotMapError extends Error {}

/**
 * Starts the AR session and resolves with the scan when the session ends (Done, or the phone's
 * back button). Rejects with CannotMapError if the phone can neither measure depth nor detect
 * surfaces, or with the browser's own error if AR can't start at all.
 */
export async function startScan(
  overlay: HTMLElement,
  onProgress: (progress: ScanProgress) => void,
): Promise<RoomScan> {
  const system = xr();
  if (!system) throw new DOMException("WebXR is not available", "NotSupportedError");
  // One request with everything but tracking optional: a failed request can use up the tap that
  // allowed it, so there is no second try. What was granted decides the mode below.
  const session = await system.requestSession("immersive-ar", {
    // "local" is available in every AR session; the floor height is found from the scan itself.
    requiredFeatures: ["local"],
    optionalFeatures: ["depth-sensing", "hit-test", "camera-access", "dom-overlay"],
    domOverlay: { root: overlay },
    depthSensing: {
      usagePreference: ["cpu-optimized"],
      dataFormatPreference: ["luminance-alpha", "float32"],
    },
  });
  active = session;

  const canvas = document.createElement("canvas");
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false });
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local");
  const scene = new Scene();
  const camera = new PerspectiveCamera();

  // Live preview: one point per confirmed voxel, drawn over the camera image.
  const positions = new Float32Array(MAX_VOXELS * 3);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);
  const material = new PointsMaterial({
    color: "#3ddc84",
    size: VOXEL_SIZE * 0.8,
    transparent: true,
    opacity: 0.7,
  });
  scene.add(new Points(geometry, material));

  const map = new VoxelMap();
  const path: Vec3[] = [];
  const inverses = new WeakMap<Float32Array, number[] | null>();
  let frame = 0;
  let lastReport = "";

  const ended = new Promise<void>((resolve) => session.addEventListener("end", () => resolve()));
  try {
    await renderer.xr.setSession(session as unknown as XRSession);
  } catch (error) {
    // Don't leave the camera running behind a session nobody can see.
    active = null;
    renderer.dispose();
    await session.end().catch(() => {});
    throw error;
  }

  let mode: ScanMode =
    session.enabledFeatures?.includes("depth-sensing") === false ? "surfaces" : "depth";
  let rays: unknown[] = mode === "surfaces" ? await hitTestRays(session) : [];
  if (mode === "surfaces" && rays.length === 0) {
    active = null;
    await session.end().catch(() => {});
    throw new CannotMapError("No depth sensing or hit-test");
  }

  let snapshots = 0;
  let snapshotState: SnapshotState = "off";
  let depthModel: typeof import("./depth") | null = null;
  let flip: boolean | null = null;
  let still = 0;
  let lastSnapshot = Number.NEGATIVE_INFINITY;
  const recent: { point: Vec3; time: number }[] = [];
  const gl = renderer.getContext();

  function startSnapshots(): void {
    if (snapshotState !== "off") return;
    snapshotState = "loading";
    import("./depth")
      .then(async (module) => {
        await module.loadDepthModel();
        depthModel = module;
        snapshotState = "ready";
      })
      .catch((error: unknown) => {
        console.error(error);
        snapshotState = "unavailable";
      });
  }
  if (mode === "surfaces") startSnapshots();

  /** Runs the model on a camera image and adds its points; picks the image orientation once. */
  async function measure(
    image: ImageData,
    snapshot: Omit<Snapshot, "disp" | "size">,
    hits: Vec3[],
  ): Promise<boolean> {
    if (!depthModel) return false;
    const { DEPTH_SIZE, estimateInverseDepth } = depthModel;
    const tryFlip = async (f: boolean) => {
      const disp = await estimateInverseDepth(image, f);
      return snapshotPoints({ ...snapshot, disp, size: DEPTH_SIZE }, hits);
    };
    let result: ReturnType<typeof snapshotPoints>;
    if (flip === null) {
      // Camera images may read back upside down; keep whichever way lines up with the hits.
      const [upright, flipped] = [await tryFlip(false), await tryFlip(true)];
      const up = upright?.fit.inliers ?? -1;
      const down = flipped?.fit.inliers ?? -1;
      if (up < 0 && down < 0) return false;
      flip = down > up;
      result = flip ? flipped : upright;
    } else {
      result = await tryFlip(flip);
    }
    if (!result) return false;
    for (const point of result.points) {
      addPoint(map, positions, new DOMPointReadOnly(...point), MIN_HITS);
    }
    snapshots++;
    geometry.setDrawRange(0, map.size);
    geometry.getAttribute("position").needsUpdate = true;
    return true;
  }

  let previous: { matrix: Float32Array; time: number } | null = null;
  // Frames in a row turning slowly enough; depth is read only after two, since it trails the pose.
  let calm = 0;

  renderer.setAnimationLoop((time, xrFrame) => {
    const f = xrFrame as unknown as XRFrameLike | undefined;
    const space = renderer.xr.getReferenceSpace();
    // Callbacks without an XR frame (before the session is fully up) say nothing about tracking.
    if (!f || !space) return;
    const pose = f.getViewerPose(space);
    const tracking = !!pose && !pose.emulatedPosition;
    const lead = pose?.views[0];
    let tooFast = false;
    if (lead) {
      if (previous && time > previous.time) {
        const rate =
          turnAngle(previous.matrix, lead.transform.matrix) / ((time - previous.time) / 1000);
        tooFast = rate > MAX_TURN_RATE;
        still = rate < STILL_RATE ? still + 1 : 0;
      }
      previous = { matrix: Float32Array.from(lead.transform.matrix), time };
    }
    calm = tracking && !tooFast ? calm + 1 : 0;
    if (pose && lead && tracking && mode === "surfaces") {
      // Hit tests are computed for this exact frame, so no calm-down period is needed.
      for (const ray of rays) {
        const hit = f.getHitTestResults(ray)[0]?.getPose(space);
        if (!hit) continue;
        addPoint(map, positions, hit.transform.position);
        const { x, y, z } = hit.transform.position;
        recent.push({ point: [x, y, z], time });
      }
      while (recent.length > 0 && time - (recent[0]?.time ?? time) > RECENT_HITS_MS) recent.shift();
      if (
        (snapshotState === "ready" || snapshotState === "unaligned") &&
        still >= STILL_FRAMES &&
        performance.now() - lastSnapshot > SNAPSHOT_EVERY_MS
      ) {
        const image = lead.camera ? readCamera(renderer, gl, lead.camera) : null;
        if (!image) {
          snapshotState = "unavailable"; // no camera access on this phone
        } else {
          snapshotState = "measuring";
          const pose = {
            viewToWorld: Float32Array.from(lead.transform.matrix),
            projection: Float32Array.from(lead.projectionMatrix),
          };
          measure(
            image,
            pose,
            recent.map((r) => r.point),
          )
            .catch((error: unknown) => {
              console.error(error);
              return false;
            })
            .then((added) => {
              // Count the gap from the end: a slow phone must not measure back to back.
              lastSnapshot = performance.now();
              if (snapshotState === "measuring") snapshotState = added ? "ready" : "unaligned";
            });
        }
      }
      trackPath(path, lead.transform.position);
      geometry.setDrawRange(0, map.size);
      geometry.getAttribute("position").needsUpdate = true;
    }
    if (pose && mode === "depth" && calm >= 2 && frame++ % DEPTH_EVERY === 0) {
      for (const view of pose.views) {
        let depth: XRDepthInfo | null;
        try {
          depth = f.getDepthInformation(view);
        } catch {
          // Depth wasn't granted after all (older Chrome doesn't list enabledFeatures).
          mode = "surfaces";
          startSnapshots();
          void hitTestRays(session).then((created) => {
            rays = created;
            if (created.length === 0) finishScan();
          });
          break;
        }
        if (!depth) continue;
        if (!inverses.has(view.projectionMatrix)) {
          inverses.set(view.projectionMatrix, invert(view.projectionMatrix));
        }
        const inv = inverses.get(view.projectionMatrix);
        if (!inv) continue;
        sample(depth, inv, view.transform.matrix, map, positions);
        trackPath(path, view.transform.position);
      }
      geometry.setDrawRange(0, map.size);
      const attribute = geometry.getAttribute("position");
      attribute.needsUpdate = true;
    }
    const report = `${mode}|${snapshots}|${snapshotState}|${map.size}|${tracking}|${tooFast}|${map.isFull}`;
    if (report !== lastReport) {
      lastReport = report;
      onProgress({
        mode,
        snapshots,
        snapshotState,
        voxels: map.size,
        tracking,
        tooFast,
        full: map.isFull,
      });
    }
    renderer.render(scene, camera);
  });

  await ended;
  renderer.setAnimationLoop(null);
  geometry.dispose();
  material.dispose();
  renderer.dispose();
  active = null;
  return { voxels: [...map.confirmed()], path, mode, snapshots };
}

/** A fixed fan of hit-test rays from the phone; empty if the phone can't hit-test. */
async function hitTestRays(session: XRSessionLike): Promise<unknown[]> {
  const Ray = (window as unknown as { XRRay?: XRRayConstructor }).XRRay;
  if (!Ray) return [];
  try {
    const viewer = await session.requestReferenceSpace("viewer");
    const rays: Promise<unknown>[] = [];
    for (let r = 0; r < RAY_ROWS; r++) {
      for (let c = 0; c < RAY_COLS; c++) {
        const x = Math.tan(((2 * c) / (RAY_COLS - 1) - 1) * RAY_SPREAD_X * (Math.PI / 180));
        const y = Math.tan(((2 * r) / (RAY_ROWS - 1) - 1) * RAY_SPREAD_Y * (Math.PI / 180));
        const offsetRay = new Ray({ x: 0, y: 0, z: 0, w: 1 }, { x, y, z: -1, w: 0 });
        rays.push(session.requestHitTestSource({ space: viewer, offsetRay }));
      }
    }
    return await Promise.all(rays);
  } catch {
    return [];
  }
}

/**
 * Copies the camera image of this frame to CPU memory (rows as WebGL reads them — possibly bottom
 * first). Null if the phone gives no image or it can't be read back.
 */
function readCamera(
  renderer: WebGLRenderer,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  camera: { width: number; height: number },
): ImageData | null {
  const texture = (renderer.xr.getBinding() as unknown as XRBindingLike).getCameraImage(camera);
  if (!texture) return null;
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const framebuffer = gl.createFramebuffer();
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const pixels = new Uint8ClampedArray(camera.width * camera.height * 4);
    gl.readPixels(0, 0, camera.width, camera.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return new ImageData(pixels, camera.width, camera.height);
  } catch {
    return null;
  } finally {
    // Put back what three.js had bound, so its state cache stays true.
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    gl.deleteFramebuffer(framebuffer);
  }
}

function addPoint(map: VoxelMap, positions: Float32Array, p: DOMPointReadOnly, weight = 1): void {
  const before = map.size;
  if (map.add(p.x, p.y, p.z, weight) === "confirmed") {
    const [x, y, z] = voxelCentre(...voxelOf(p.x, p.y, p.z));
    positions.set([x, y, z], before * 3);
  }
}

function trackPath(path: Vec3[], { x, y, z }: DOMPointReadOnly): void {
  const last = path.at(-1);
  if (!last || Math.hypot(x - last[0], y - last[1], z - last[2]) >= PATH_STEP) path.push([x, y, z]);
}

/** Reads a grid of depth samples from one view and adds them to the map. */
function sample(
  depth: XRDepthInfo,
  invProjection: number[],
  viewToWorld: Float32Array,
  map: VoxelMap,
  positions: Float32Array,
): void {
  for (let r = 0; r < SAMPLE_ROWS; r++) {
    for (let c = 0; c < SAMPLE_COLS; c++) {
      const u = (c + 0.5) / SAMPLE_COLS;
      const v = (r + 0.5) / SAMPLE_ROWS;
      const point = unproject(u, v, depth.getDepthInMeters(u, v), invProjection, viewToWorld);
      if (point) addPoint(map, positions, new DOMPointReadOnly(...point));
    }
  }
}
