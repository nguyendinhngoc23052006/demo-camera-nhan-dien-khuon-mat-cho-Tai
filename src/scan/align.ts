// Pure maths for turning a depth model's relative output into metres. Monocular depth models
// (MiDaS and kin) predict inverse depth up to an unknown scale and shift, so for each photo we fit
//   1 / depth ≈ scale · prediction + shift
// against a few points whose true distance the phone measured (hit tests on flat surfaces).
import { type Mat4, transformPoint, type Vec3 } from "./map";

/** Fewest measured points that make a fit trustworthy. */
export const MIN_FIT_POINTS = 6;
/** Measured points must span at least this depth ratio (far / near), or scale is undetermined. */
export const MIN_DEPTH_RATIO = 1.3;

export interface Fit {
  scale: number;
  shift: number;
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
  return { scale, shift: (sy - scale * sx) / n };
}

/** A measured point agrees with a fit when its inverse depth is within this fraction. */
const INLIER_TOLERANCE = 0.1;

/**
 * Fits scale and shift from (model prediction, measured depth in metres) pairs. Every pair of
 * points proposes a fit; the one most points agree with wins and is refined on those points, so a
 * hit on the wrong surface (or a mistaken prediction at an edge) can't bend the whole photo.
 * Null when the points can't determine a fit, or it would make nearer things look farther.
 */
export function fitInverseDepth(samples: readonly { pred: number; depth: number }[]): Fit | null {
  const points = samples
    .filter((s) => Number.isFinite(s.pred) && s.depth > 0)
    .map((s) => ({ pred: s.pred, inv: 1 / s.depth }));
  if (points.length < MIN_FIT_POINTS) return null;
  const depths = points.map((p) => 1 / p.inv);
  if (Math.max(...depths) / Math.min(...depths) < MIN_DEPTH_RATIO) return null;

  const agrees = (p: { pred: number; inv: number }, f: Fit) =>
    Math.abs(f.scale * p.pred + f.shift - p.inv) <= INLIER_TOLERANCE * p.inv;
  let best: { pred: number; inv: number }[] = [];
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const candidate = leastSquares([points[a], points[b]] as { pred: number; inv: number }[]);
      if (!candidate || !(candidate.scale > 0)) continue;
      const inliers = points.filter((p) => agrees(p, candidate));
      if (inliers.length > best.length) best = inliers;
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
