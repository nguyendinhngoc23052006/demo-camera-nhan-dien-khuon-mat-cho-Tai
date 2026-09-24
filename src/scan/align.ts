// Pure maths for turning a depth model's relative output into metres. Monocular depth models
// (MiDaS and kin) predict inverse depth up to an unknown scale and shift, so for each photo we fit
//   1 / depth ≈ scale · prediction + shift
// against a few points whose true distance is known: hit tests on flat surfaces, or, on a phone
// without AR, where rays must meet the floor.
import {
  invert,
  MAX_RANGE,
  type Mat4,
  OBSTACLE_MIN_HEIGHT,
  transformPoint,
  unproject,
  type Vec3,
} from "./map";

/** Fewest measured points that make a fit trustworthy. */
export const MIN_FIT_POINTS = 6;
/** Measured points must span at least this depth ratio (far / near), or scale is undetermined. */
export const MIN_DEPTH_RATIO = 1.3;
/**
 * A snapshot is trusted only this far outside the distances it was fitted on (as a fraction):
 * inverse-depth fits blow small errors up with distance, so beyond it points are dropped.
 */
export const EXTRAPOLATION_MARGIN = 0.15;

export interface Fit {
  scale: number;
  shift: number;
  /** How many measured points agreed with the fit. */
  inliers: number;
  /** Nearest and farthest agreeing measured point, metres. */
  near: number;
  far: number;
}

/** Where a world point lands in a view: normalized coords (origin top-left, v down) and depth. */
export function projectToView(
  point: Vec3,
  worldToView: Mat4,
  projection: Mat4,
): { u: number; v: number; depth: number } | null {
  const view = transformPoint(worldToView, ...point);
  if (!(view[2] < 0)) return null; // behind the camera
  const [x, y] = transformPoint(projection, ...view);
  const u = (x + 1) / 2;
  const v = (1 - y) / 2;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v, depth: -view[2] };
}

function leastSquares(points: readonly { pred: number; inv: number }[]): Fit | null {
  const inliers = points.length;
  const near = 1 / Math.max(...points.map((p) => p.inv));
  const far = 1 / Math.min(...points.map((p) => p.inv));
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const { pred, inv } of points) {
    sx += pred;
    sy += inv;
    sxx += pred * pred;
    sxy += pred * inv;
  }
  const det = n * sxx - sx * sx;
  if (!(Math.abs(det) > 1e-12)) return null;
  const scale = (n * sxy - sx * sy) / det;
  return { scale, shift: (sy - scale * sx) / n, inliers, near, far };
}

/** A measured point agrees with a fit when its inverse depth is within this fraction. */
const INLIER_TOLERANCE = 0.1;

/**
 * Fits scale and shift from (model prediction, measured depth in metres) pairs. Every pair of
 * points proposes a fit; the one most points agree with wins and is refined on those points, so a
 * hit on the wrong surface (or a mistaken prediction at an edge) can't bend the whole photo.
 * With `bounds`, each depth is only the farthest the point can be (where its ray would meet the
 * floor; it may hit furniture first), so a fit that puts points clearly beyond it is penalised:
 * otherwise a room full of furniture could outvote the floor.
 * Null when the points can't determine a fit, or it would make nearer things look farther.
 */
export function fitInverseDepth(
  samples: readonly { pred: number; depth: number }[],
  bounds = false,
): Fit | null {
  const points = samples
    .filter((s) => Number.isFinite(s.pred) && s.depth > 0)
    .map((s) => ({ pred: s.pred, inv: 1 / s.depth }));
  if (points.length < MIN_FIT_POINTS) return null;
  const depths = points.map((p) => 1 / p.inv);
  if (Math.max(...depths) / Math.min(...depths) < MIN_DEPTH_RATIO) return null;

  // A bound is only on the floor when the fit puts it right there; hitting something nearer is
  // common and only slightly nearer (a wall's foot) must not count as floor and bias the refit.
  const nearSide = bounds ? INLIER_TOLERANCE / 3 : INLIER_TOLERANCE;
  const agrees = (p: { pred: number; inv: number }, f: Fit) => {
    const error = f.scale * p.pred + f.shift - p.inv;
    return error <= nearSide * p.inv && -error <= INLIER_TOLERANCE * p.inv;
  };
  const beyond = (p: { pred: number; inv: number }, f: Fit) =>
    f.scale * p.pred + f.shift < (1 - INLIER_TOLERANCE) * p.inv;
  let best: { pred: number; inv: number }[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const candidate = leastSquares([points[a], points[b]] as { pred: number; inv: number }[]);
      if (!candidate || !(candidate.scale > 0)) continue;
      const inliers = points.filter((p) => agrees(p, candidate));
      const score =
        inliers.length - (bounds ? points.filter((p) => beyond(p, candidate)).length : 0);
      if (score > bestScore) {
        bestScore = score;
        best = inliers;
      }
    }
  }
  if (best.length < MIN_FIT_POINTS) return null;
  const fit = leastSquares(best);
  // Models predict larger values for nearer things; a non-positive scale means the fit is noise.
  return fit && fit.scale > 0 ? fit : null;
}

/** Metres for one prediction, or null where the fit says "at or beyond infinity". */
export function metricDepth(pred: number, fit: Fit): number | null {
  const inv = fit.scale * pred + fit.shift;
  return inv > 1e-6 ? 1 / inv : null;
}

/** Rays per snapshot tested against the floor (columns × rows) in a one-spot scan. */
export const FLOOR_COLS = 16;
export const FLOOR_ROWS = 12;

/**
 * Where a grid of the view's rays would meet a floor at y = 0 (the camera is at the pose's height),
 * for a phone with no way to measure distance. Rays may hit furniture or walls first, so these are
 * farthest-possible points: pass them to snapshotPoints with `floor`.
 */
export function floorHits(viewToWorld: Mat4, projection: Mat4): Vec3[] {
  const invProjection = invert(projection);
  if (!invProjection) return [];
  const eye = transformPoint(viewToWorld, 0, 0, 0);
  const hits: Vec3[] = [];
  for (let r = 0; r < FLOOR_ROWS; r++) {
    for (let c = 0; c < FLOOR_COLS; c++) {
      const u = (c + 0.5) / FLOOR_COLS;
      const v = (r + 0.5) / FLOOR_ROWS;
      const tip = transformPoint(
        viewToWorld,
        ...transformPoint(invProjection, 2 * u - 1, 1 - 2 * v, -1),
      );
      const dir = [tip[0] - eye[0], tip[1] - eye[1], tip[2] - eye[2]] as Vec3;
      if (!(dir[1] < 0)) continue; // at or above the horizon
      const t = eye[1] / -dir[1];
      const hit: Vec3 = [eye[0] + dir[0] * t, 0, eye[2] + dir[2] * t];
      if (Math.hypot(hit[0] - eye[0], hit[2] - eye[2]) <= MAX_RANGE) hits.push(hit);
    }
  }
  return hits;
}

/** One camera image's depth estimate and where the phone was when it was taken. */
export interface Snapshot {
  /** Inverse depth, size × size, row-major, top row first (see depth.ts). */
  disp: Float32Array;
  size: number;
  viewToWorld: Mat4;
  projection: Mat4;
}

/**
 * Room points from a snapshot: fits the model's relative depth to the measured `hits` (world
 * points on surfaces the phone detected, or with `floor` the farthest-possible points from floorHits)
 * that fall inside the picture, then turns a grid of the model's depths into world points. Null
 * when the hits can't pin the fit down.
 * With `floor`, the floor is the plane y = 0: nothing can be beyond it, and anything the model puts
 * lower than an obstacle is floor, so those points are moved onto it along their ray.
 */
export function snapshotPoints(
  snapshot: Snapshot,
  hits: readonly Vec3[],
  floor = false,
): { points: Vec3[]; fit: Fit } | null {
  const { disp, size, viewToWorld, projection } = snapshot;
  const worldToView = invert(viewToWorld);
  const invProjection = invert(projection);
  if (!worldToView || !invProjection) return null;
  const at = (u: number, v: number) =>
    disp[
      Math.min(size - 1, Math.floor(v * size)) * size + Math.min(size - 1, Math.floor(u * size))
    ] ?? Number.NaN;

  const samples: { pred: number; depth: number }[] = [];
  for (const hit of hits) {
    const seen = projectToView(hit, worldToView, projection);
    if (seen) samples.push({ pred: at(seen.u, seen.v), depth: seen.depth });
  }
  const fit = fitInverseDepth(samples, floor);
  if (!fit) return null;
  const eye = transformPoint(viewToWorld, 0, 0, 0);

  // Every model pixel becomes a point: dense enough that a real surface gets several points per
  // voxel and shows up solid, while a stray point stays below MIN_HITS.
  const points: Vec3[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const u = (c + 0.5) / size;
      const v = (r + 0.5) / size;
      const depth = metricDepth(at(u, v), fit);
      if (
        depth === null ||
        depth > fit.far * (1 + EXTRAPOLATION_MARGIN) ||
        depth < fit.near * (1 - EXTRAPOLATION_MARGIN)
      ) {
        continue;
      }
      const point = unproject(u, v, depth, invProjection, viewToWorld);
      if (!point) continue;
      if (floor && point[1] < OBSTACLE_MIN_HEIGHT && eye[1] > OBSTACLE_MIN_HEIGHT) {
        const t = eye[1] / (eye[1] - point[1]);
        points.push([eye[0] + (point[0] - eye[0]) * t, 0, eye[2] + (point[2] - eye[2]) * t]);
      } else {
        points.push(point);
      }
    }
  }
  return { points, fit };
}
