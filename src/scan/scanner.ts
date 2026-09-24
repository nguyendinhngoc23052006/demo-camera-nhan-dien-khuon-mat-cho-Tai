// The only file that touches WebXR. Runs an immersive-ar session and turns what the phone
// measures into voxels (see map.ts), with a live preview over the camera image. Two sources:
// - "depth": CPU depth maps, on phones whose ARCore supports depth (the full room shape);
// - "surfaces": a grid of hit-test rays against the flat surfaces ARCore detects (floor, walls,
//   tables) — every ARCore phone can do this, depth or not.
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
import {
  invert,
  MAX_TURN_RATE,
  MAX_VOXELS,
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

export interface ScanProgress {
  mode: ScanMode;
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

/**
 * Starts the AR session and resolves with the scan when the session ends (Done, or the phone's
 * back button). Rejects with NotSupportedError if the phone can neither measure depth nor
 * detect surfaces.
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
    optionalFeatures: ["depth-sensing", "hit-test", "dom-overlay"],
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
    throw new DOMException("No depth sensing or hit-test", "NotSupportedError");
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
      }
      previous = { matrix: Float32Array.from(lead.transform.matrix), time };
    }
    calm = tracking && !tooFast ? calm + 1 : 0;
    if (pose && lead && tracking && mode === "surfaces") {
      // Hit tests are computed for this exact frame, so no calm-down period is needed.
      for (const ray of rays) {
        const hit = f.getHitTestResults(ray)[0]?.getPose(space);
        if (hit) addPoint(map, positions, hit.transform.position);
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
    const report = `${mode}|${map.size}|${tracking}|${tooFast}|${map.isFull}`;
    if (report !== lastReport) {
      lastReport = report;
      onProgress({ mode, voxels: map.size, tracking, tooFast, full: map.isFull });
    }
    renderer.render(scene, camera);
  });

  await ended;
  renderer.setAnimationLoop(null);
  geometry.dispose();
  material.dispose();
  renderer.dispose();
  active = null;
  return { voxels: [...map.confirmed()], path, mode };
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

function addPoint(map: VoxelMap, positions: Float32Array, p: DOMPointReadOnly): void {
  const before = map.size;
  if (map.add(p.x, p.y, p.z) === "confirmed") {
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
