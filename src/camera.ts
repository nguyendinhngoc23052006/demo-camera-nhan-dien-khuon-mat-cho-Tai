import { type MatchResult, matchFace, nameKey } from "./core/faces";
import { getGallery, subscribe } from "./gallery";
import { type DetectedFace, detectFaces } from "./vision";

export type ModelState = "loading" | "ready" | "error";

type StageState =
  | "loading"
  | "models-failed"
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "denied"
  | "no-camera"
  | "busy"
  | "insecure"
  | "ended"
  | "failed";

type Tone = "plain" | "busy" | "error";

const COPY: Record<Exclude<StageState, "running">, { title: string; text: string; tone: Tone }> = {
  loading: {
    title: "Getting ready",
    text: "Loading the face models. This takes a few seconds the first time.",
    tone: "busy",
  },
  "models-failed": {
    title: "The face models didn't load",
    text: "Use Try again at the top of the page.",
    tone: "error",
  },
  idle: {
    title: "Camera is off",
    text: "Start the camera and everyone in view gets a label.",
    tone: "plain",
  },
  starting: {
    title: "Starting the camera…",
    text: "If your browser asks, allow camera access.",
    tone: "busy",
  },
  paused: {
    title: "Camera paused",
    text: "It stops while this page is in the background. Start it again when you're ready.",
    tone: "plain",
  },
  denied: {
    title: "Camera access is blocked",
    text: "Allow the camera for this site in your browser's settings, then try again.",
    tone: "error",
  },
  "no-camera": {
    title: "No camera found",
    text: "Connect a camera, or open this page on your phone.",
    tone: "error",
  },
  busy: {
    title: "The camera is busy",
    text: "Another app is using it. Close that app, then try again.",
    tone: "error",
  },
  insecure: {
    title: "The camera needs a secure page",
    text: "Open this page over https to use the camera.",
    tone: "error",
  },
  ended: {
    title: "The camera disconnected",
    text: "Reconnect it, then start the camera again.",
    tone: "error",
  },
  failed: {
    title: "Face scanning stopped",
    text: "Something went wrong. Start the camera to try again.",
    tone: "error",
  },
};

const TOGGLE: Record<StageState, { label: string; enabled: boolean }> = {
  loading: { label: "Start camera", enabled: false },
  "models-failed": { label: "Start camera", enabled: false },
  insecure: { label: "Start camera", enabled: false },
  idle: { label: "Start camera", enabled: true },
  paused: { label: "Start camera", enabled: true },
  ended: { label: "Start camera", enabled: true },
  failed: { label: "Start camera", enabled: true },
  starting: { label: "Stop camera", enabled: true },
  running: { label: "Stop camera", enabled: true },
  denied: { label: "Try again", enabled: true },
  "no-camera": { label: "Try again", enabled: true },
  busy: { label: "Try again", enabled: true },
};

interface Palette {
  font: string;
  fill: Record<MatchResult["kind"], string>;
  text: Record<MatchResult["kind"], string>;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function createCameraView(options: { onAddFace: () => void }) {
  const frameEl = byId<HTMLDivElement>("camera");
  const stage = byId<HTMLDivElement>("stage");
  const video = byId<HTMLVideoElement>("camera-video");
  const overlay = byId<HTMLCanvasElement>("camera-overlay");
  const title = byId<HTMLParagraphElement>("stage-title");
  const text = byId<HTMLParagraphElement>("stage-text");
  const toggle = byId<HTMLButtonElement>("camera-toggle");
  const addFace = byId<HTMLButtonElement>("camera-add");
  const facesList = byId<HTMLUListElement>("camera-faces");
  const ctx = overlay.getContext("2d");
  // face-api re-reads a <video> at each of its three stages, so boxes and face prints would come
  // from different frames. One still per tick gives every stage, and the drawn box, the same pixels.
  const still = document.createElement("canvas");
  const stillCtx = still.getContext("2d");

  let state: StageState = "loading";
  let stream: MediaStream | null = null;
  let frame = 0;
  // Bumped by every start and stop. Anything async compares its captured run to this and bails if
  // it changed, so a camera grant or a detection that resolves after Stop can't revive or redraw.
  let run = 0;
  let palette: Palette | null = null;
  let announced = "";

  // Canvas labels are invisible to screen readers; mirror them as text, only when they change.
  function announce(labels: readonly string[]): void {
    const key = labels.join("\n");
    if (key === announced) return;
    announced = key;
    facesList.replaceChildren(
      ...labels.map((label) => {
        const item = document.createElement("li");
        item.textContent = label;
        return item;
      }),
    );
  }

  function renderPanel(): void {
    if (state === "running") return;
    const copy = COPY[state];
    const count = new Set(getGallery().map((e) => nameKey(e.name))).size;
    stage.dataset.tone = copy.tone;
    title.textContent = copy.title;
    text.textContent = state === "idle" ? idleText(count) : copy.text;
    addFace.hidden = count > 0 || !(state === "idle" || state === "loading" || state === "paused");
  }

  function setState(next: StageState): void {
    state = next;
    stage.dataset.state = next;
    renderPanel();
    toggle.textContent = TOGGLE[next].label;
    toggle.disabled = !TOGGLE[next].enabled;
    toggle.classList.toggle("btn-primary", next !== "running" && next !== "starting");
    toggle.classList.toggle("btn-secondary", next === "running" || next === "starting");
    toggle.dataset.live = String(next === "running");
  }

  const isActive = () => state === "starting" || state === "running";

  function stop(next: StageState): void {
    run++;
    cancelAnimationFrame(frame);
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.pause();
    video.srcObject = null;
    ctx?.clearRect(0, 0, overlay.width, overlay.height);
    announce([]);
    setState(next);
  }

  async function start(): Promise<void> {
    const id = ++run;
    if (!hasCamera()) {
      setState("insecure");
      return;
    }
    setState("starting");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
    } catch (error) {
      if (id === run) setState(classify(error));
      return;
    }
    if (id !== run) {
      for (const track of media.getTracks()) track.stop();
      return;
    }
    stream = media;
    for (const track of media.getVideoTracks()) {
      track.addEventListener("ended", () => {
        if (id === run) stop("ended");
      });
    }
    video.srcObject = media;
    try {
      await video.play();
    } catch (error) {
      if (id === run) {
        console.error(error);
        stop("failed");
      }
      return;
    }
    if (id !== run) return;
    palette = readPalette();
    setState("running");
    schedule(id);
  }

  function schedule(id: number): void {
    frame = requestAnimationFrame(() => void tick(id));
  }

  async function tick(id: number): Promise<void> {
    if (id !== run) return;
    if (
      stillCtx &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0
    ) {
      let faces: DetectedFace[];
      try {
        if (still.width !== video.videoWidth) still.width = video.videoWidth;
        if (still.height !== video.videoHeight) still.height = video.videoHeight;
        stillCtx.drawImage(video, 0, 0);
        faces = await detectFaces(still);
      } catch (error) {
        if (id === run) {
          console.error(error);
          stop("failed");
        }
        return;
      }
      if (id !== run) return;
      draw(faces);
    }
    schedule(id);
  }

  function draw(faces: readonly DetectedFace[]): void {
    if (!ctx || !palette) return;
    // The still's size, not the video's: boxes are in the still's pixels even if the camera rotated.
    const vw = still.width;
    const vh = still.height;
    if (overlay.width !== vw || overlay.height !== vh) {
      overlay.width = vw;
      overlay.height = vh;
      frameEl.style.setProperty("--ar", String(vw / vh));
    }
    ctx.clearRect(0, 0, vw, vh);
    // Video and overlay share object-fit: contain, so one scale maps canvas px to screen px.
    const shown = Math.min(overlay.clientWidth / vw, overlay.clientHeight / vh) || 1;
    const px = 1 / shown;
    const gallery = getGallery();
    const labels: string[] = [];
    for (const face of faces) {
      const result = matchFace(face.descriptor, gallery);
      labels.push(labelFor(result));
      drawFace(ctx, palette, face.box, result, px, vw, vh);
    }
    announce(labels);
  }

  toggle.addEventListener("click", () => {
    if (isActive()) stop("idle");
    else void start();
  });
  addFace.addEventListener("click", options.onAddFace);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isActive()) stop("paused");
  });
  window.addEventListener("pagehide", () => {
    if (isActive()) stop("paused");
  });

  subscribe(renderPanel);
  setState("loading");

  return {
    hide(): void {
      if (isActive()) stop("idle");
    },
    setModelState(models: ModelState): void {
      if (isActive()) return;
      if (models === "ready") {
        if (state === "loading" || state === "models-failed") {
          setState(hasCamera() ? "idle" : "insecure");
        }
      } else if (models === "error") setState("models-failed");
      else setState("loading");
    },
  };
}

/** False on plain-http pages, where browsers hide the camera API entirely. */
function hasCamera(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === "function";
}

function idleText(people: number): string {
  if (people === 0) return "No one added yet — add a face first.";
  const who = people === 1 ? "1 person" : `${people} people`;
  return `It knows ${who}. Start the camera and everyone in view gets a label.`;
}

function classify(error: unknown): StageState {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-camera";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  console.error(error);
  return "failed";
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    font: getComputedStyle(document.body).fontFamily,
    fill: { match: v("--green"), unsure: v("--amber"), unknown: v("--grey") },
    text: { match: v("--on-green"), unsure: v("--on-amber"), unknown: v("--on-grey") },
  };
}

function labelFor(result: MatchResult): string {
  if (result.kind === "match") return result.name;
  if (result.kind === "unsure") return `Not sure: ${result.names[0]} or ${result.names[1]}?`;
  return "Unknown";
}

/** `px` is canvas pixels per CSS pixel, so strokes and labels stay the same size on screen. */
function drawFace(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  box: DetectedFace["box"],
  result: MatchResult,
  px: number,
  vw: number,
  vh: number,
): void {
  const fill = palette.fill[result.kind];
  // The video is mirrored with CSS and this canvas is not, so mirror x here to keep text readable.
  const x = vw - box.x - box.width;
  const { y, width, height } = box;
  const line = Math.max(2, 2.5 * px);
  const radius = Math.min(10 * px, width / 4, height / 4);

  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = line + 2 * px;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.stroke();
  ctx.strokeStyle = fill;
  ctx.lineWidth = line;
  ctx.stroke();

  const size = Math.max(10, Math.min(15 * px, vh * 0.07));
  const padX = size * 0.6;
  const lineH = size * 1.3;
  const gap = size * 0.4;
  ctx.font = `600 ${size}px ${palette.font}`;
  const lines = labelLines(ctx, result, vw - 2 * gap - 2 * padX);
  const pillW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 2 * padX;
  const pillH = lines.length * lineH + size * 0.5;
  const pillX = Math.min(Math.max(x, gap), vw - pillW - gap);
  const above = y - gap - pillH;
  const pillY = above >= gap ? above : Math.min(y + height + gap, vh - pillH - gap);

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, size * 0.9);
  ctx.fill();
  ctx.fillStyle = palette.text[result.kind];
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => {
    ctx.fillText(l, pillX + padX, pillY + size * 0.25 + (i + 0.5) * lineH + size * 0.04);
  });
}

/** One line when it fits. "Not sure" wraps and shortens each name, so both people stay visible. */
function labelLines(
  ctx: CanvasRenderingContext2D,
  result: MatchResult,
  maxWidth: number,
): string[] {
  const label = labelFor(result);
  if (ctx.measureText(label).width <= maxWidth) return [label];
  if (result.kind !== "unsure") return [truncate(ctx, label, maxWidth)];
  const [a, b] = result.names;
  const both = `${a} or ${b}?`;
  if (ctx.measureText(both).width <= maxWidth) return ["Not sure:", both];
  const room = maxWidth - ctx.measureText(" or ?").width;
  // Half the room each; a name shorter than its half hands the rest to the other.
  const fitA = truncate(ctx, a, Math.max(room / 2, room - ctx.measureText(b).width));
  const fitB = truncate(ctx, b, room - ctx.measureText(fitA).width);
  return ["Not sure:", `${fitA} or ${fitB}?`];
}

function truncate(ctx: CanvasRenderingContext2D, label: string, maxWidth: number): string {
  if (ctx.measureText(label).width <= maxWidth) return label;
  const chars = Array.from(label);
  while (chars.length > 1 && ctx.measureText(`${chars.join("")}…`).width > maxWidth) chars.pop();
  return `${chars.join("")}…`;
}
