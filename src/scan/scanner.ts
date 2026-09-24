// The only file that touches WebXR. Runs an immersive-ar session, reads CPU depth each few
// frames, turns it into voxels (see map.ts) and draws a live preview over the camera image.
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

export interface ScanProgress {
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
}
interface XRSessionLike extends EventTarget {
  end(): Promise<void>;
}
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
 * back button). Rejects if the session can't start (e.g. NotSupportedError: no depth sensing).
 */
export async function startScan(
  overlay: HTMLElement,
  onProgress: (progress: ScanProgress) => void,
): Promise<RoomScan> {
  const system = xr();
  if (!system) throw new DOMException("WebXR is not available", "NotSupportedError");
  const session = await system.requestSession("immersive-ar", {
    // "local" is available in every AR session; the floor height is found from the scan itself.
    requiredFeatures: ["depth-sensing", "local"],
    optionalFeatures: ["dom-overlay"],
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
    if (pose && calm >= 2 && frame++ % DEPTH_EVERY === 0) {
      for (const view of pose.views) {
        const depth = f.getDepthInformation(view);
        if (!depth) continue;
        if (!inverses.has(view.projectionMatrix)) {
          inverses.set(view.projectionMatrix, invert(view.projectionMatrix));
        }
        const inv = inverses.get(view.projectionMatrix);
        if (!inv) continue;
        sample(depth, inv, view.transform.matrix, map, positions);
        const { x, y, z } = view.transform.position;
        const last = path.at(-1);
        if (!last || Math.hypot(x - last[0], y - last[1], z - last[2]) >= PATH_STEP)
          path.push([x, y, z]);
      }
      geometry.setDrawRange(0, map.size);
      const attribute = geometry.getAttribute("position");
      attribute.needsUpdate = true;
    }
    const report = `${map.size}|${tracking}|${tooFast}|${map.isFull}`;
    if (report !== lastReport) {
      lastReport = report;
      onProgress({ voxels: map.size, tracking, tooFast, full: map.isFull });
    }
    renderer.render(scene, camera);
  });

  await ended;
  renderer.setAnimationLoop(null);
  geometry.dispose();
  material.dispose();
  renderer.dispose();
  active = null;
  return { voxels: [...map.confirmed()], path };
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
      if (!point) continue;
      const before = map.size;
      if (map.add(point[0], point[1], point[2]) === "confirmed") {
        const [x, y, z] = voxelCentre(...voxelOf(point[0], point[1], point[2]));
        positions.set([x, y, z], before * 3);
      }
    }
  }
}
