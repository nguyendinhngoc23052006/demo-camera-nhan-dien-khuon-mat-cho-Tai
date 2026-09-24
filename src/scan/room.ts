// The "3D room" tab: checks the device, runs a scan, then shows the result. Phones with AR scan
// while walking (scanner.ts); others scan from one spot (spot.ts). The heavy parts (three.js,
// WebXR, the depth model) load only when this tab is first opened.
import { type RoomScan, VOXEL_SIZE } from "./map";
import type { ScanProgress } from "./scanner";
import type { Viewer, ViewMode } from "./viewer";

type State =
  | "checking"
  | "unsupported"
  | "ready"
  | "starting"
  | "scanning"
  | "empty"
  | "denied"
  | "no-ar"
  | "no-depth"
  | "failed"
  | "done";

type Tone = "plain" | "busy" | "error";

const COPY: Record<Exclude<State, "done">, { title: string; text: string; tone: Tone }> = {
  checking: { title: "Checking this device…", text: "", tone: "busy" },
  unsupported: {
    title: "Room scans need a phone",
    text: "Open this page on a phone. A computer can't tell which way it points, so it can't scan a room.",
    tone: "plain",
  },
  ready: {
    title: "Rebuild the room in 3D",
    text: "Walk slowly around the room with the phone. When you tap Done, the room appears here in 3D and as a map.",
    tone: "plain",
  },
  starting: {
    title: "Starting the scan…",
    text: "If your phone asks, allow the camera.",
    tone: "busy",
  },
  scanning: {
    title: "Scanning…",
    text: "Follow the instructions on the camera screen.",
    tone: "busy",
  },
  empty: {
    title: "Nothing was captured",
    text: "Move more slowly, keep the room well lit, and point the phone at walls and the floor.",
    tone: "error",
  },
  denied: {
    title: "Camera access is blocked",
    text: "Allow the camera (and, on iPhone, motion sensors) for this site in the browser's settings, then try again.",
    tone: "error",
  },
  // Chrome can report AR as available and still refuse to start it, typically when Google Play
  // Services for AR is missing, disabled or out of date.
  "no-ar": {
    title: "AR couldn't start on this phone",
    text: "Chrome needs the app Google Play Services for AR. Install or update it from the Play Store (or the phone's own app store), then try again.",
    tone: "error",
  },
  "no-depth": {
    title: "This phone can't map the room",
    text: "It supports AR, but neither depth sensing nor surface detection.",
    tone: "error",
  },
  failed: {
    title: "The scan stopped",
    text: "Something went wrong. Try again.",
    tone: "error",
  },
};

const SPOT_READY =
  "Stand in the middle of the room with the phone at chest height and turn slowly on the spot. When you tap Done, the room appears here in 3D and as a map.";
const NO_AR_SPOT =
  "It needs Google Play Services for AR, which this phone can't install. You can still scan from one spot: the room as seen from where you stand.";
const SPOT_HINT =
  "Stay on one spot, phone at chest height, tilted a little down so the floor shows. Turn slowly and pause for a second at each new direction. Tap Done when you have turned all the way round.";
const DEPTH_HINT =
  "Walk slowly and point the phone at the walls, the floor and the furniture. Tap Done, or press Back, when you have covered the room.";
const SURFACES_HINT =
  "Sweep the floor and walls slowly. Every so often hold still for a second: a snapshot fills in chairs and anything else that isn't flat. Tap Done, or press Back, when finished.";
const SURFACES_ONLY_HINT =
  "This phone can't give the camera image to the page, so only flat surfaces are mapped: floor, walls, tables. Sweep them slowly; tap Done, or press Back, when finished.";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function createRoomView() {
  const stage = byId<HTMLDivElement>("room-stage");
  const title = byId<HTMLParagraphElement>("room-title");
  const text = byId<HTMLParagraphElement>("room-text");
  const scanButton = byId<HTMLButtonElement>("room-scan");
  const modes = byId<HTMLFieldSetElement>("room-modes");
  const stats = byId<HTMLParagraphElement>("room-stats");
  const model = byId<HTMLCanvasElement>("room-model");
  const plan = byId<HTMLCanvasElement>("room-plan");
  const overlay = byId<HTMLDivElement>("scan-overlay");
  const video = byId<HTMLVideoElement>("scan-video");
  const status = byId<HTMLParagraphElement>("scan-status");
  const hint = byId<HTMLParagraphElement>("scan-hint");
  const done = byId<HTMLButtonElement>("scan-done");

  let state: State = "checking";
  let checked = false;
  let scanner: typeof import("./scanner") | null = null;
  let spot: typeof import("./spot") | null = null;
  // "ar": walk around with WebXR; "spot": turn on one spot, for phones without AR.
  let method: "ar" | "spot" = "ar";
  let viewer: Viewer | null = null;
  let scan: RoomScan | null = null;

  function setState(next: State, detail?: string): void {
    state = next;
    stage.dataset.state = next;
    if (next !== "done") {
      const copy = COPY[next];
      stage.dataset.tone = copy.tone;
      title.textContent = copy.title;
      text.textContent = detail ?? copy.text;
    }
    const idle = next === "ready" || next === "empty" || next === "failed" || next === "done";
    scanButton.disabled = !(idle || next === "denied" || next === "no-ar" || next === "no-depth");
    scanButton.textContent = scan
      ? "Scan again"
      : method === "spot"
        ? "Scan from one spot"
        : "Rebuild the room in 3D";
    scanButton.hidden = next === "unsupported" || next === "checking";
    modes.hidden = !(next === "done" && scan);
    stats.hidden = modes.hidden;
    model.hidden = next !== "done";
  }

  async function check(): Promise<void> {
    checked = true;
    setState("checking");
    try {
      scanner = await import("./scanner");
      if (await scanner.canScan()) setState("ready");
      else if (await spotAvailable()) setState("ready", SPOT_READY);
      else setState("unsupported");
    } catch (error) {
      console.error(error);
      setState("failed", "The 3D tools didn't load. Reload the page and try again.");
    }
  }

  /** Switches to the one-spot scan if this device can do it. */
  async function spotAvailable(): Promise<boolean> {
    spot ??= await import("./spot");
    if (!(await spot.canSpotScan())) return false;
    method = "spot";
    return true;
  }

  function showProgress(p: ScanProgress): void {
    const blocks = p.voxels.toLocaleString();
    hint.textContent =
      p.mode === "spot"
        ? SPOT_HINT
        : p.mode === "depth"
          ? DEPTH_HINT
          : p.snapshotState === "unavailable"
            ? SURFACES_ONLY_HINT
            : SURFACES_HINT;
    if (p.full) {
      status.dataset.tone = "warn";
      status.textContent = `Scan is full (${blocks} blocks) — tap Done`;
    } else if (!p.tracking) {
      status.dataset.tone = "warn";
      status.textContent = "Lost track — move slower, or add light";
    } else if (p.tooFast) {
      status.dataset.tone = "warn";
      status.textContent = "Turning too fast — slow down";
    } else if (p.snapshotState === "measuring") {
      delete status.dataset.tone;
      status.textContent = "Hold still — measuring…";
    } else if (p.snapshotState === "unaligned") {
      status.dataset.tone = "warn";
      status.textContent =
        p.mode === "spot"
          ? "Tilt down so more floor shows, then hold still"
          : "Hold still with the floor and a wall or furniture in view";
    } else if (p.snapshotState === "covered") {
      status.dataset.tone = "warn";
      status.textContent = "Already captured — turn to a new direction";
    } else if (p.mode === "spot" && p.snapshotState === "unavailable") {
      status.dataset.tone = "warn";
      status.textContent = "The depth model didn't load — tap Done and try again";
    } else if (p.snapshotState === "loading") {
      delete status.dataset.tone;
      status.textContent = `Scanning — ${blocks} blocks (loading the depth model…)`;
    } else {
      delete status.dataset.tone;
      const shots = p.snapshots === 1 ? "1 snapshot" : `${p.snapshots} snapshots`;
      status.textContent =
        p.mode !== "depth" && p.snapshots > 0
          ? `Scanning — ${blocks} blocks · ${shots}`
          : `Scanning — ${blocks} blocks`;
    }
  }

  async function start(): Promise<void> {
    if (!scanner) return;
    setState("starting");
    overlay.dataset.mode = method;
    video.hidden = method !== "spot";
    overlay.hidden = false;
    status.textContent = "Starting…";
    hint.textContent = method === "spot" ? SPOT_HINT : DEPTH_HINT;
    let result: RoomScan;
    try {
      const running =
        method === "spot" && spot
          ? spot.startSpotScan(video, showProgress)
          : scanner.startScan(overlay, showProgress);
      setState("scanning");
      result = await running;
    } catch (error) {
      overlay.hidden = true;
      const name = error instanceof DOMException ? error.name : "";
      const said =
        error instanceof Error && error.message ? ` Chrome said: "${error.message}"` : "";
      if (name === "NotAllowedError" || name === "SecurityError") setState("denied");
      else if (error instanceof scanner.CannotMapError) setState("no-depth");
      else if (spot && error instanceof spot.NoMotionSensorError) setState("unsupported");
      else if (name === "NotSupportedError") {
        const fallback = await spotAvailable().catch(() => false);
        setState("no-ar", (fallback ? NO_AR_SPOT : COPY["no-ar"].text) + said);
      } else {
        console.error(error);
        setState("failed", COPY.failed.text + said);
      }
      return;
    }
    overlay.hidden = true;
    if (result.voxels.length === 0) {
      setState("empty");
      return;
    }
    scan = result;
    viewer ??= (await import("./viewer")).createViewer(model, plan);
    setState("done");
    viewer.show(result);
    setMode("3d");
    stats.textContent = describe(result);
  }

  function setMode(mode: ViewMode): void {
    for (const button of modes.querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    viewer?.setMode(mode);
  }

  scanButton.addEventListener("click", () => void start());
  done.addEventListener("click", () => {
    scanner?.finishScan();
    spot?.finishSpotScan();
  });
  modes.addEventListener("click", (event) => {
    const mode = (event.target as HTMLElement).closest("button")?.dataset.mode;
    if (mode === "3d" || mode === "map") setMode(mode);
  });

  return {
    /** Called when the tab opens; the device check runs once, on first open. */
    show(): void {
      if (!checked) void check();
    },
    get scanning(): boolean {
      return state === "starting" || state === "scanning";
    },
  };
}

/** "12,340 blocks · about 4.1 × 3.2 m" */
function describe(scan: RoomScan): string {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [i, , k] of scan.voxels) {
    minX = Math.min(minX, i);
    maxX = Math.max(maxX, i);
    minZ = Math.min(minZ, k);
    maxZ = Math.max(maxZ, k);
  }
  const metres = (span: number) => ((span + 1) * VOXEL_SIZE).toFixed(1);
  const size = `${scan.voxels.length.toLocaleString()} blocks · about ${metres(maxX - minX)} × ${metres(maxZ - minZ)} m`;
  if (scan.mode === "depth") return size;
  if (scan.mode === "spot") return `${size} · from one spot, sizes approximate`;
  if (scan.snapshots === 0) return `${size} · flat surfaces only`;
  return `${size} · ${scan.snapshots === 1 ? "1 snapshot" : `${scan.snapshots} snapshots`}`;
}
