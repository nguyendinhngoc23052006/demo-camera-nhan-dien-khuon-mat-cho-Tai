import { createCameraView, type ModelState } from "./camera";
import { createEnrollView } from "./enroll";
import { getGallery, storageWarning } from "./gallery";
import { loadModels } from "./vision";

type View = "camera" | "enroll";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const status = byId<HTMLParagraphElement>("model-status");
const statusText = byId<HTMLSpanElement>("model-status-text");
const modelError = byId<HTMLDivElement>("model-error");
const retry = byId<HTMLButtonElement>("model-retry");
const storageBanner = byId<HTMLDivElement>("storage-warning");
const storageText = byId<HTMLParagraphElement>("storage-warning-text");

const VIEWS: readonly View[] = ["camera", "enroll"];
const tabs: Record<View, HTMLButtonElement> = {
  camera: byId("tab-camera"),
  enroll: byId("tab-enroll"),
};
const panels: Record<View, HTMLElement> = {
  camera: byId("view-camera"),
  enroll: byId("view-enroll"),
};

const STATUS_TEXT: Record<ModelState, string> = {
  loading: "Loading models…",
  ready: "Ready",
  error: "Models didn't load",
};

let modelState: ModelState = "loading";
let tracked: Promise<void> | null = null;

const camera = createCameraView({ onAddFace: () => select("enroll", true) });
const enroll = createEnrollView({ ensureModels });

function setModelState(next: ModelState): void {
  modelState = next;
  status.dataset.state = next;
  statusText.textContent = STATUS_TEXT[next];
  modelError.hidden = next !== "error";
  camera.setModelState(next);
  enroll.setModelState(next);
}

/** Every model load goes through here so the header, banner and both views agree on the state. */
function ensureModels(): Promise<void> {
  const models = loadModels();
  if (models !== tracked) {
    tracked = models;
    if (modelState !== "ready") setModelState("loading");
    models.then(
      () => setModelState("ready"),
      (error: unknown) => {
        console.error(error);
        setModelState("error");
      },
    );
  }
  return models;
}

function select(view: View, focus = false): void {
  for (const key of VIEWS) {
    const on = key === view;
    tabs[key].setAttribute("aria-selected", String(on));
    tabs[key].tabIndex = on ? 0 : -1;
    panels[key].hidden = !on;
  }
  if (view !== "camera") camera.hide();
  if (view !== "enroll") enroll.hide();
  if (focus) tabs[view].focus();
}

for (const key of VIEWS) {
  tabs[key].addEventListener("click", () => select(key));
  tabs[key].addEventListener("keydown", (event) => {
    const index = VIEWS.indexOf(key);
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: VIEWS.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = VIEWS[(target + VIEWS.length) % VIEWS.length];
    if (next) select(next, true);
  });
}

retry.addEventListener("click", () => {
  ensureModels().catch(() => {});
});

if (storageWarning) {
  storageText.textContent = storageWarning;
  storageBanner.hidden = false;
}

select(getGallery().length > 0 ? "camera" : "enroll");
ensureModels().catch(() => {});
