# CLAUDE.md — the rules this project obeys

Face-recognition demo for Tài. A friend adds a face (photo + name); the webcam labels whoever it
sees. Everything happens inside one browser tab; Cloudflare Pages only serves the static files.

## Stack

Vite + vanilla TypeScript · Biome · Vitest · `@vladmandic/face-api` · Cloudflare Pages Git build
(`npm run build` → `dist`) · Node from `.node-version` (Pages and CI both read it). Nothing else.

## The rules that cannot be broken

1. **Browser-only, by the owner's decision.** No server, no database, no API, no uploads, no
   analytics. Faces live in `sessionStorage` and die with the tab. Adding D1, KV, R2, Supabase or
   a Worker "to keep faces" is a different product — ask, don't build.
2. **`src/core/faces.ts` alone decides identity.** Every threshold, margin and photo rule is an
   exported constant there; no other file compares descriptors or judges a match. It stays pure:
   no DOM, no imports.
3. **Tests are relative to the constants** (`MATCH_THRESHOLD - 0.01`), never literal numbers, so
   re-tuning a constant never touches a test.
4. **One door each.** `src/vision.ts` is the only file importing face-api; `src/gallery.ts` the
   only file touching storage.
5. **Names reach the screen via `textContent` or canvas `fillText` only** — never `innerHTML` with data.
6. **face-api is pinned exactly (`1.7.15`, upstream archived).** Never a range, never a CDN. Model
   weights are copied from `node_modules` to `public/models/` by `scripts/copy-models.mjs` at
   dev/build time and are never committed.
7. **No audio, nothing recorded.** Camera frames are analysed and discarded.
8. **Fail on screen.** Models, camera and storage failures are visible messages, not console lines.

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
