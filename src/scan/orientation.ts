// Pure maths for the one-spot scan, where the phone has a camera and motion sensors but no AR:
// the phone's orientation (DeviceOrientationEvent angles) becomes a camera pose, and a typical
// phone camera stands in for the lens the browser doesn't describe. No DOM, so it can be tested.
import type { Mat4 } from "./map";

/** Assumed height of the phone above the floor, metres: held at chest height. Sizes scale with it. */
export const SPOT_EYE_HEIGHT = 1.4;
/** Assumed field of view along the long side of the camera image, degrees (a 26 mm-equivalent lens). */
export const CAMERA_FOV = 67;

const RAD = Math.PI / 180;

type Mat3 = number[]; // 3×3, row-major

function mul(a: Mat3, b: Mat3): Mat3 {
  const at = (m: Mat3, r: number, c: number) => m[r * 3 + c] as number;
  return Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3);
    const c = i % 3;
    return at(a, r, 0) * at(b, 0, c) + at(a, r, 1) * at(b, 1, c) + at(a, r, 2) * at(b, 2, c);
  });
}

// biome-ignore format: matrix rows
const rx = (t: number): Mat3 => [
  1, 0, 0,
  0, Math.cos(t), -Math.sin(t),
  0, Math.sin(t), Math.cos(t),
];
// biome-ignore format: matrix rows
const ry = (t: number): Mat3 => [
  Math.cos(t), 0, Math.sin(t),
  0, 1, 0,
  -Math.sin(t), 0, Math.cos(t),
];
// biome-ignore format: matrix rows
const rz = (t: number): Mat3 => [
  Math.cos(t), -Math.sin(t), 0,
  Math.sin(t), Math.cos(t), 0,
  0, 0, 1,
];
// Earth frame (x east, y north, z up) → scan world (x east, y up, z south), as map.ts expects.
// biome-ignore format: matrix rows
const EARTH_TO_WORLD: Mat3 = [
  1, 0, 0,
  0, 0, 1,
  0, -1, 0,
];

/**
 * Camera pose (view → world, column-major) from DeviceOrientationEvent angles in degrees and the
 * screen's rotation (screen.orientation.angle). The view looks along -z with y up the screen, as in
 * WebXR; the camera sits `eyeHeight` above a floor at y = 0.
 */
export function orientationPose(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
  eyeHeight = SPOT_EYE_HEIGHT,
): number[] {
  const device = mul(mul(rz(alpha * RAD), rx(beta * RAD)), ry(gamma * RAD));
  const r = mul(mul(EARTH_TO_WORLD, device), rz(-screenAngle * RAD));
  const column = (c: number) => [r[c], r[3 + c], r[6 + c], 0] as number[];
  return [...column(0), ...column(1), ...column(2), 0, eyeHeight, 0, 1];
}

/** Projection matrix (column-major) for a camera image of this size, with CAMERA_FOV on its long side. */
export function cameraProjection(width: number, height: number): Mat4 {
  const long = 1 / Math.tan((CAMERA_FOV / 2) * RAD);
  const fx = width >= height ? long : (long * height) / width;
  const fy = height >= width ? long : (long * width) / height;
  const near = 0.1;
  const far = 100;
  const a = (far + near) / (near - far);
  const b = (2 * far * near) / (near - far);
  return [fx, 0, 0, 0, 0, fy, 0, 0, 0, 0, a, -1, 0, 0, b, 0];
}
