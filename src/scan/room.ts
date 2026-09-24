// The "3D room" tab: checks the device, runs a scan, then shows the result. The heavy parts
// (three.js, WebXR) load only when this tab is first opened.
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
  | "no-depth"
  | "failed"
  | "done";

type Tone = "plain" | "busy" | "error";

const COPY: Record<Exclude<State, "done">, { title: string; text: string; tone: Tone }> = {
  checking: { title: "Checking this device…", text: "", tone: "busy" },
  unsupported: {
    title: "Room scans need an Android phone",
    text: "Open this page in Chrome on an Android phone with Google Play Services for AR. iPhones and computers can't scan a room from a web page.",
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
    text: "Allow the camera for this site in Chrome's settings, then try again.",
    tone: "error",
  },
  "no-depth": {
    title: "This phone can't measure depth",
    text: "It supports AR but not depth sensing, which the room scan needs.",
    tone: "error",
  },
  failed: {
    title: "The scan stopped",
    text: "Something went wrong. Try again.",
    tone: "error",
  },
};

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
  const status = byId<HTMLParagraphElement>("scan-status");
  const done = byId<HTMLButtonElement>("scan-done");

  let state: State = "checking";
  let checked = false;
  let scanner: typeof import("./scanner") | null = null;
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
    scanButton.disabled = !(idle || next === "denied" || next === "no-depth");
    scanButton.textContent = scan ? "Scan again" : "Rebuild the room in 3D";
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
      setState((await scanner.canScan()) ? "ready" : "unsupported");
    } catch (error) {
      console.error(error);
      setState("failed", "The 3D tools didn't load. Reload the page and try again.");
    }
  }

  function showProgress(p: ScanProgress): void {
    const blocks = p.voxels.toLocaleString();
    if (p.full) {
      status.dataset.tone = "warn";
      status.textContent = `Scan is full (${blocks} blocks) — tap Done`;
    } else if (!p.tracking) {
      status.dataset.tone = "warn";
      status.textContent = "Lost track — move slower, or add light";
    } else {
      delete status.dataset.tone;
      status.textContent = `Scanning — ${blocks} blocks`;
    }
  }

  async function start(): Promise<void> {
    if (!scanner) return;
    setState("starting");
    overlay.hidden = false;
    status.textContent = "Starting…";
    let result: RoomScan;
    try {
      const running = scanner.startScan(overlay, showProgress);
      setState("scanning");
      result = await running;
    } catch (error) {
      overlay.hidden = true;
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") setState("denied");
      else if (name === "NotSupportedError") setState("no-depth");
      else {
        console.error(error);
        setState("failed");
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
  done.addEventListener("click", () => scanner?.finishScan());
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
  return `${scan.voxels.length.toLocaleString()} blocks · about ${metres(maxX - minX)} × ${metres(maxZ - minZ)} m`;
}
