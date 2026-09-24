# CLAUDE.md — the rules this project obeys

Face-recognition demo for Tài. A friend adds a face (photo + name); the webcam labels whoever it
sees. A second mode rebuilds the room in 3D: walking around on Android phones with AR (WebXR), or
turning on one spot on any phone with a camera and motion sensors. Everything happens inside
one browser tab; Cloudflare Pages only serves the static files.

## Stack

Vite + vanilla TypeScript · Biome · Vitest · opencv.js (`@techstark/opencv-js`) running the OpenCV
Zoo models YuNet + SFace · three.js (3D room only, loaded when that tab opens) · WebXR
immersive-ar with CPU depth sensing or hit-test + camera access · LiteRT.js (`@litertjs/core`,
TensorFlow Lite for the web) running Depth Anything V2 Small, for phones without depth sensing ·
DeviceOrientation + camera for the one-spot scan on phones without AR ·
Cloudflare Pages Git build (`npm run build` → `dist`) ·
Node from `.node-version` (Pages and CI both read it). Nothing else.

## The rules that cannot be broken

1. **Browser-only, by the owner's decision.** No server, no database, no API, no uploads, no
   analytics. Faces live in `sessionStorage` and die with the tab. Adding D1, KV, R2, Supabase or
   a Worker "to keep faces" is a different product — ask, don't build.
2. **`src/core/faces.ts` alone decides identity.** Every threshold, margin and photo rule is an
   exported constant there; no other file compares descriptors or judges a match. It stays pure:
   no DOM, no imports.
3. **Tests are relative to the constants** (`MATCH_THRESHOLD - 0.01`), never literal numbers, so
   re-tuning a constant never touches a test.
4. **One door each.** `src/vision.ts` is the only file touching OpenCV; `src/gallery.ts` the
   only file touching storage; `src/scan/scanner.ts` the only file touching WebXR;
   `src/scan/spot.ts` the only file touching motion sensors; `src/scan/depth.ts` the only file
   touching LiteRT. Scan geometry (depth → voxels → plan) stays pure in `src/scan/map.ts`,
   fitting the depth model to measured points or the floor in `src/scan/align.ts`, and phone
   orientation → camera pose in `src/scan/orientation.ts`; all are tested against a simulated room.
5. **Names reach the screen via `textContent` or canvas `fillText` only** — never `innerHTML` with data.
6. **Models are pinned by checksum.** opencv.js is pinned exactly in `package.json`; YuNet and
   SFace live in `models/` (not on npm) with their licences, and so does the depth model, which
   `models/convert-depth-anything/` rebuilds byte-for-byte from its public source.
   `scripts/copy-models.mjs` verifies every SHA-256 and copies them to `public/` at dev/build
   time. Never a CDN. A new face model means re-tuning the constants on a multi-ethnic test set,
   judged by the worst group.
7. **No audio, nothing recorded.** Camera frames are analysed and discarded. A room scan keeps
   only the room's shape (5 cm blocks and the walked path) in memory; it is never saved or sent.
   A depth snapshot's camera image is used once for the depth model and then discarded.
8. **The 3D room is a map, never a substitute for looking.** Copy must not suggest walking by the
   model alone: scans age, and glass, thin objects and stair edges can be missing.
9. **Fail on screen.** Models, camera and storage failures are visible messages, not console lines.

## How you work

Restate the goal; touch only what the task needs; minimum code. One PR into `main` per change.

## Quality gate — before every PR

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass (CI runs the same)
- [ ] Identity logic changed only in `src/core/faces.ts`, with a test for every new branch
- [ ] No request to another origin, no new storage key, no new dependency
- [ ] README names constants, never their values (values live only in `src/core/faces.ts`)
- [ ] Camera and Add a face checked at 360 px wide with a long name and 3 photos: no horizontal
      scroll, buttons ≥ 44 px tall
- [ ] PR body says what changed and how to undo it
