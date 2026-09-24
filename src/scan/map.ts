// Pure geometry for the room scan: depth samples → world points → voxel map → top-down plan.
// No DOM, no WebXR, no three.js, so it can be tested against a simulated room.

/** Edge of one voxel, metres. */
export const VOXEL_SIZE = 0.05;
/** A voxel is shown only after this many depth hits, which filters single-frame noise. */
export const MIN_HITS = 3;
/** Depth readings outside this range (metres) are ignored: phone depth is unreliable there. */
export const MIN_RANGE = 0.3;
export const MAX_RANGE = 4.5;
/** Hard cap so a long scan can't exhaust a phone's memory; the UI says so when it is reached. */
export const MAX_VOXELS = 150_000;
/**
 * Depth is skipped while the phone turns faster than this (degrees per second): the depth image
 * trails the pose slightly, so fast turns would smear walls into rotated copies.
 */
export const MAX_TURN_RATE = 60;
/** Heights above the floor (metres) that count as an obstacle on the top-down plan. */
export const OBSTACLE_MIN_HEIGHT = 0.1;
export const OBSTACLE_MAX_HEIGHT = 1.8;

/** A 4x4 matrix in WebGL/WebXR column-major order. */
export type Mat4 = ArrayLike<number>;
export type Vec3 = [number, number, number];

export function transformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  const e = (i: number) => m[i] as number;
  const w = e(3) * x + e(7) * y + e(11) * z + e(15);
  return [
    (e(0) * x + e(4) * y + e(8) * z + e(12)) / w,
    (e(1) * x + e(5) * y + e(9) * z + e(13)) / w,
    (e(2) * x + e(6) * y + e(10) * z + e(14)) / w,
  ];
}

/**
 * World position of a depth sample. `u`, `v` are normalized view coordinates (0..1, origin at the
 * top-left of the view, v growing downwards); `depth` is the distance in metres from the view plane
 * along the view's forward axis. `invProjection` undoes the view's projection matrix and
 * `viewToWorld` is the view's pose (XRView.transform.matrix). Returns null outside the trusted range.
 */
export function unproject(
  u: number,
  v: number,
  depth: number,
  invProjection: Mat4,
  viewToWorld: Mat4,
): Vec3 | null {
  if (!(depth >= MIN_RANGE && depth <= MAX_RANGE)) return null;
  // A point on the near plane in view space; its direction from the eye is the sample's ray.
  const [x, y, z] = transformPoint(invProjection, 2 * u - 1, 1 - 2 * v, -1);
  if (!(z < 0)) return null;
  const scale = depth / -z;
  return transformPoint(viewToWorld, x * scale, y * scale, z * scale);
}

// Voxel indices are packed into one exact integer key (±32768 voxels ≈ ±1.6 km per axis).
const OFFSET = 32768;
const SPAN = 65536;

export function voxelKey(i: number, j: number, k: number): number {
  return ((i + OFFSET) * SPAN + (j + OFFSET)) * SPAN + (k + OFFSET);
}

export function voxelIndex(key: number): Vec3 {
  const k = (key % SPAN) - OFFSET;
  const rest = Math.floor(key / SPAN);
  const j = (rest % SPAN) - OFFSET;
  const i = Math.floor(rest / SPAN) - OFFSET;
  return [i, j, k];
}

export function voxelOf(x: number, y: number, z: number): Vec3 {
  return [Math.floor(x / VOXEL_SIZE), Math.floor(y / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE)];
}

/** Centre of a voxel, metres. */
export function voxelCentre(i: number, j: number, k: number): Vec3 {
  return [(i + 0.5) * VOXEL_SIZE, (j + 0.5) * VOXEL_SIZE, (k + 0.5) * VOXEL_SIZE];
}

export type AddResult = "added" | "confirmed" | "full";

export class VoxelMap {
  private readonly hits = new Map<number, number>();
  private confirmedCount = 0;

  /**
   * Counts `weight` hits (default one measurement). "confirmed" means the voxel just reached
   * MIN_HITS and should now be drawn.
   */
  add(x: number, y: number, z: number, weight = 1): AddResult {
    const [i, j, k] = voxelOf(x, y, z);
    const key = voxelKey(i, j, k);
    const before = this.hits.get(key) ?? 0;
    const hits = before + weight;
    if (before === 0 && this.hits.size >= MAX_VOXELS * 4) return "full";
    this.hits.set(key, hits);
    if (!(before < MIN_HITS && hits >= MIN_HITS)) return "added";
    if (this.confirmedCount >= MAX_VOXELS) return "full";
    this.confirmedCount++;
    return "confirmed";
  }

  /** Voxels drawn so far. */
  get size(): number {
    return this.confirmedCount;
  }

  get isFull(): boolean {
    return this.confirmedCount >= MAX_VOXELS;
  }

  *confirmed(): Generator<Vec3> {
    for (const [key, hits] of this.hits) {
      if (hits >= MIN_HITS) yield voxelIndex(key);
    }
  }
}

export interface FloorPlan {
  /** Voxel column range covered by the plan (inclusive). */
  minI: number;
  maxI: number;
  minK: number;
  maxK: number;
  /** Columns with something between OBSTACLE_MIN_HEIGHT and OBSTACLE_MAX_HEIGHT above the floor. */
  obstacles: Set<number>;
  /** Columns where the floor itself was seen. */
  floor: Set<number>;
}

/** Key for a top-down column (i along x, k along z). */
export function columnKey(i: number, k: number): number {
  return voxelKey(i, 0, k);
}

/**
 * Top-down plan of the room. `floorY` is the floor height in the scan's coordinates (0 when the
 * scan used a floor-level reference space). Returns null when nothing was scanned.
 */
export function floorPlan(voxels: Iterable<Vec3>, floorY = 0): FloorPlan | null {
  const low = Math.floor((floorY + OBSTACLE_MIN_HEIGHT) / VOXEL_SIZE);
  const high = Math.floor((floorY + OBSTACLE_MAX_HEIGHT) / VOXEL_SIZE);
  const floorLayer = Math.floor(floorY / VOXEL_SIZE);
  const plan: FloorPlan = {
    minI: Number.POSITIVE_INFINITY,
    maxI: Number.NEGATIVE_INFINITY,
    minK: Number.POSITIVE_INFINITY,
    maxK: Number.NEGATIVE_INFINITY,
    obstacles: new Set(),
    floor: new Set(),
  };
  for (const [i, j, k] of voxels) {
    plan.minI = Math.min(plan.minI, i);
    plan.maxI = Math.max(plan.maxI, i);
    plan.minK = Math.min(plan.minK, k);
    plan.maxK = Math.max(plan.maxK, k);
    if (j >= low && j <= high) plan.obstacles.add(columnKey(i, k));
    else if (Math.abs(j - floorLayer) <= 1) plan.floor.add(columnKey(i, k));
  }
  return plan.obstacles.size + plan.floor.size > 0 || Number.isFinite(plan.minI) ? plan : null;
}

/** Inverse of a 4x4 matrix (column-major), or null when it has none. */
export function invert(m: Mat4): number[] | null {
  const a = Array.from({ length: 16 }, (_, i) => m[i] as number);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/**
 * Floor height of a scan, metres: the lowest voxel layer holding at least half as many voxels as
 * the busiest layer (floors and ceilings are the big horizontal layers; the floor is the lower).
 * Works whether or not the phone reported a floor-level coordinate system.
 */
export function estimateFloorY(voxels: Iterable<Vec3>): number | null {
  const layers = new Map<number, number>();
  for (const [, j] of voxels) layers.set(j, (layers.get(j) ?? 0) + 1);
  if (layers.size === 0) return null;
  const busiest = Math.max(...layers.values());
  const floor = Math.min(...[...layers].filter(([, n]) => n * 2 >= busiest).map(([j]) => j));
  return floor * VOXEL_SIZE;
}

/** "depth": the whole room shape; "surfaces": only flat surfaces the phone detected. */
export type ScanMode = "depth" | "surfaces";

/** A finished scan: the confirmed voxels and the positions the phone walked through. */
export interface RoomScan {
  voxels: Vec3[];
  path: Vec3[];
  mode: ScanMode;
  /** Camera snapshots turned into depth (surfaces mode only). */
  snapshots: number;
}

/** Angle in degrees between the forward (-z) axes of two poses (view → world matrices). */
export function turnAngle(a: Mat4, b: Mat4): number {
  const [ax, ay, az] = [a[8] as number, a[9] as number, a[10] as number];
  const [bx, by, bz] = [b[8] as number, b[9] as number, b[10] as number];
  const dot = ax * bx + ay * by + az * bz;
  const len = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
  return (Math.acos(Math.min(1, Math.max(-1, dot / len))) * 180) / Math.PI;
}
