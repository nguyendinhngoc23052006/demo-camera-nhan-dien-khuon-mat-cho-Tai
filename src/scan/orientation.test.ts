import { describe, expect, it } from "vitest";
import { invert, transformPoint } from "./map";
import { CAMERA_FOV, cameraProjection, orientationPose, SPOT_EYE_HEIGHT } from "./orientation";

/** Where the camera looks (-z) and which way is up the screen (+y), in world coordinates. */
function axes(pose: number[]) {
  return {
    forward: [-(pose[8] as number), -(pose[9] as number), -(pose[10] as number)],
    up: [pose[4] as number, pose[5] as number, pose[6] as number],
  };
}

function expectVec(actual: number[], expected: number[]) {
  actual.forEach((value, i) => {
    expect(value).toBeCloseTo(expected[i] as number, 9);
  });
}

describe("orientationPose", () => {
  it("looks down when the phone lies flat, screen up", () => {
    expectVec(axes(orientationPose(0, 0, 0, 0)).forward, [0, -1, 0]);
  });

  it("looks level along -z when held upright in portrait", () => {
    const { forward, up } = axes(orientationPose(0, 90, 0, 0));
    expectVec(forward, [0, 0, -1]);
    expectVec(up, [0, 1, 0]);
  });

  it("turns left as alpha grows", () => {
    expectVec(axes(orientationPose(90, 90, 0, 0)).forward, [-1, 0, 0]);
  });

  it("keeps the picture upright in landscape", () => {
    // Upright, turned a quarter anticlockwise: the screen's right edge points at the ceiling.
    const { forward, up } = axes(orientationPose(0, 0, -90, 90));
    expectVec(forward, [1, 0, 0]);
    expectVec(up, [0, 1, 0]);
  });

  it("holds the camera at the assumed height", () => {
    expectVec(transformPoint(orientationPose(30, 80, 5, 0), 0, 0, 0), [0, SPOT_EYE_HEIGHT, 0]);
  });
});

describe("cameraProjection", () => {
  it("spreads CAMERA_FOV over the long side of the picture", () => {
    const tan = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
    const portrait = invert(cameraProjection(480, 640)) as number[];
    const [, y, z] = transformPoint(portrait, 0, 1, -1);
    expect(y / -z).toBeCloseTo(tan, 9);
    const [x, , z2] = transformPoint(portrait, 1, 0, -1);
    expect(x / -z2).toBeCloseTo((tan * 480) / 640, 9);
  });
});
