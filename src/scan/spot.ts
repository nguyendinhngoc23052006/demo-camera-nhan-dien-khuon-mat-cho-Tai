// The only file that touches the motion sensors. The one-spot scan, for phones that can't run AR:
// the person stands still and turns around; the motion sensors say which way the phone points
// (orientation.ts), and at each pause a camera frame goes through the depth model (depth.ts),
// scaled by where the floor must be (align.ts). No position tracking, so everything is seen from
// one spot. Camera frames are used once and discarded; only the room's shape is kept, in memory.
import { floorHits, snapshotPoints } from "./align";
import { MAX_TURN_RATE, MIN_HITS, type RoomScan, turnAngle, type Vec3, VoxelMap } from "./map";
import { cameraProjection, orientationPose, SPOT_EYE_HEIGHT } from "./orientation";
import type { ScanProgress, SnapshotState } from "./scanner";

/** A shot is taken once the phone has turned slower than this (°/s) for STILL_MS. */
const STILL_RATE = 10;
const STILL_MS = 500;
/** How often the latest orientation is checked, ms. */
const TICK_MS = 50;
/** A new shot must point at least this far (degrees) from every earlier one. */
const SHOT_SPACING = 20;
/** How long to wait for the first motion-sensor reading before deciding there is no sensor. */
const SENSOR_WAIT_MS = 1000;

/** The phone has a camera but no working motion sensor, so it can't tell which way it points. */
export class NoMotionSensorError extends Error {}

type Angles = { alpha: number; beta: number; gamma: number };
type PermissionRequest = { requestPermission?: () => Promise<"granted" | "denied"> };

function anglesOf(event: DeviceOrientationEvent): Angles | null {
  const { alpha, beta, gamma } = event;
  return alpha === null || beta === null || gamma === null ? null : { alpha, beta, gamma };
}

/** Resolves with the first orientation reading, or null if none comes (computers fire nulls). */
function firstReading(): Promise<Angles | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(null), SENSOR_WAIT_MS);
    const listener = (event: DeviceOrientationEvent) => {
      const angles = anglesOf(event);
      if (angles) done(angles);
    };
    function done(result: Angles | null) {
      clearTimeout(timer);
      window.removeEventListener("deviceorientation", listener);
      resolve(result);
    }
    window.addEventListener("deviceorientation", listener);
  });
}

/** True when this device has a camera and motion sensors (iPhones only say so after asking). */
export async function canSpotScan(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia || !("DeviceOrientationEvent" in window)) return false;
  if ((DeviceOrientationEvent as PermissionRequest).requestPermission) return true;
  return (await firstReading()) !== null;
}

let finish: (() => void) | null = null;

/** Ends the running one-spot scan; the promise from startSpotScan then resolves with the result. */
export function finishSpotScan(): void {
  finish?.();
}

/**
 * Runs a one-spot scan with the camera shown in `video` and resolves when finishSpotScan is
 * called. Must start from a tap: iPhones ask for motion access here. Rejects with the browser's
 * error if the camera is refused, or NoMotionSensorError.
 */
export async function startSpotScan(
  video: HTMLVideoElement,
  onProgress: (progress: ScanProgress) => void,
): Promise<RoomScan> {
  const ask = (DeviceOrientationEvent as PermissionRequest).requestPermission;
  if (ask && (await ask()) !== "granted") {
    throw new DOMException("Motion sensors were not allowed", "NotAllowedError");
  }
  const depth = await import("./depth");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
    audio: false,
  });
  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  let angles = await firstReading();
  if (!angles) {
    stop();
    throw new NoMotionSensorError("No motion sensor readings");
  }
  video.srcObject = stream;
  await video.play().catch(() => {});

  const map = new VoxelMap();
  const shots: number[][] = [];
  let snapshotState: SnapshotState = "loading";
  let tooFast = false;
  let stillSince = performance.now();
  let shotThisPause = false;
  let previous: { pose: number[]; time: number } | null = null;
  let lastReport = "";

  const pose = (a: Angles) =>
    orientationPose(a.alpha, a.beta, a.gamma, screen.orientation?.angle ?? 0);

  function report(): void {
    const progress: ScanProgress = {
      mode: "spot",
      snapshots: shots.length,
      snapshotState,
      voxels: map.size,
      tracking: true,
      tooFast,
      full: map.isFull,
    };
    const key = JSON.stringify(progress);
    if (key !== lastReport) {
      lastReport = key;
      onProgress(progress);
    }
  }

  depth
    .loadDepthModel()
    .then(() => {
      snapshotState = "ready";
      report();
    })
    .catch((error: unknown) => {
      console.error(error);
      snapshotState = "unavailable";
      report();
    });

  async function shoot(): Promise<void> {
    if (!angles || video.videoWidth === 0) return;
    const viewToWorld = pose(angles);
    if (shots.some((shot) => turnAngle(shot, viewToWorld) < SHOT_SPACING)) {
      snapshotState = "covered";
      return;
    }
    const { videoWidth: width, videoHeight: height } = video;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    snapshotState = "measuring";
    report();
    const projection = cameraProjection(width, height);
    try {
      const disp = await depth.estimateInverseDepth(image, false);
      const result = snapshotPoints(
        { disp, size: depth.DEPTH_SIZE, viewToWorld, projection },
        floorHits(viewToWorld, projection),
        true,
      );
      if (!result) {
        snapshotState = "unaligned";
        return;
      }
      for (const [x, y, z] of result.points) map.add(x, y, z, MIN_HITS);
      shots.push(viewToWorld);
      snapshotState = "ready";
    } catch (error) {
      console.error(error);
      snapshotState = "unaligned";
    }
  }

  // Browsers may skip events while the phone is still, so the pause is judged on a timer.
  const onOrientation = (event: DeviceOrientationEvent) => {
    angles = anglesOf(event) ?? angles;
  };
  const tick = () => {
    if (!angles) return;
    const now = performance.now();
    const current = pose(angles);
    if (previous && now > previous.time) {
      const rate = turnAngle(previous.pose, current) / ((now - previous.time) / 1000);
      tooFast = rate > MAX_TURN_RATE;
      if (rate >= STILL_RATE) {
        stillSince = now;
        shotThisPause = false;
        if (snapshotState === "covered") snapshotState = "ready";
      }
    }
    previous = { pose: current, time: now };
    const idle = snapshotState === "ready" || snapshotState === "unaligned";
    if (idle && !shotThisPause && !map.isFull && now - stillSince >= STILL_MS) {
      shotThisPause = true;
      void shoot().finally(report);
    }
    report();
  };

  window.addEventListener("deviceorientation", onOrientation);
  const timer = setInterval(tick, TICK_MS);
  report();
  await new Promise<void>((resolve) => {
    finish = resolve;
  });
  finish = null;
  clearInterval(timer);
  window.removeEventListener("deviceorientation", onOrientation);
  stop();
  const eye: Vec3 = [0, SPOT_EYE_HEIGHT, 0];
  return { voxels: [...map.confirmed()], path: [eye], mode: "spot", snapshots: shots.length };
}
