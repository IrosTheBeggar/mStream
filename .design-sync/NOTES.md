# design-sync notes (mStream)

Project: **mStream design cards** — https://claude.ai/design/p/9bec91f3-4103-41ed-866e-5e9731e19f6d
(created 2026-09-16 by the first sync; `projectId` is pinned in config.json).

## Shape: off-script, hand-authored cards
- mStream's webapp (`webapp/`) is Vue + plain JS, not a React component library, so the
  converter (`package-build.mjs`) has nothing to compile. `.design-sync/build-cards.mjs`
  produces the upload layout directly from the `@dsCard` HTML cards under every folder in
  `cfg.cardSets` (today `docs/designs/discover-modal` and `docs/designs/discovery-plugins-admin`;
  `cfg.cardsDir` is the older single-folder key and is ignored when `cardSets` is set). `pkg: "."` in config.json only marks the sync as
  completed; there is no package to install.
- `_ds_bundle.js` is an empty `window.MStream` namespace with an honest `components: []`
  header. `_ds_bundle.css` + `tokens/tokens.css` are cut from each set's shared `<style>`
  block and concatenated (the generator refuses to build if the first `<style>` blocks
  differ WITHIN a set, or if two sets produce the same card folder name).
- **Two sets, two looks, one stylesheet.** The Discover window is dark with un-prefixed tokens
  and `dm-*` classes; the admin panel is light and prefixes everything (`--adm-*`, `adm-*`,
  base rules scoped under `.adm-page`), which is what lets the two stylesheets share
  `_ds_bundle.css` without colliding. A new set must prefix the same way.
- **Every set that should stay in the project must be in `cardSets`.** The upload reconciles
  deletes, so a set left out of the config is removed from the project on the next sync.
- **No `_ds_sync.json` anchor** (deliberate): the anchor recipe keys on converter facts this
  layout lacks. Every sync re-verifies all cards — cheap at this size. Consequence: the
  re-sync router treats the project as un-anchored; upload = atomic path (pinned project),
  full writes + reconciliation deletes each time.

## Re-sync recipe
1. `node .design-sync/build-cards.mjs` (writes `ds-bundle/`, incl. the `_ds_needs_recompile` sentinel).
2. `node .ds-sync/package-validate.mjs ./ds-bundle` — must exit 0. Stage the scripts first if
   `.ds-sync/` is missing (`cp -r <skill>/package-*.mjs <skill>/resync.mjs <skill>/lib <skill>/storybook .ds-sync/`).
   Playwright + chromium are installed at the repo root `node_modules` (not saved to package.json)
   and `%LOCALAPPDATA%/ms-playwright`; reinstall with `npm i --no-save playwright && npx playwright install chromium`.
3. Read `ds-bundle/_screenshots/contact-sheet-1.png` once.
4. Atomic upload: sentinel → all 24 files → `list_files` diff → delete orphans → sentinel re-arm. No anchor to write.

## Pending
- 2026-09-18: the admin set (`docs/designs/discovery-plugins-admin`, 9 cards, group `Admin`) is built
  and bundles cleanly next to the Discover set (20 cards, 47 files in a dry build) but has NOT been
  synced. Next `/design-sync` = atomic path again; expect +9 card folders under `components/Admin/`,
  a longer README header (the admin vocabulary was appended to conventions.md) and the two
  concatenated stylesheets. Nothing under `components/Discover/` should change.

## Sync log
- 2026-09-16 first sync: 9 cards, 24 files.
- 2026-09-16 re-sync (atomic path, pinned project): 11 cards (+ ModalPeerPlugins, CollectionDestination), 28 files, 11/11 render clean; conventions.md had been revised by the author with the cards and every name verified.

## Known validate warns (legitimate)
- `_ds_sync.json absent` — see above.
- `tokens: 2 missing` = `--c` and `--pct`, per-element inline variables on `.dm-matchbar` /
  progress bars (`style="--pct:92%;--c:#657ee4"`), not design tokens.
- `.d.ts parse check skipped` — there are no `.d.ts` files in this shape.

## Conventions-check false positives
- `b`, `i`, `em`, `s`, `label` in conventions.md are HTML element selectors (`.path b`, `.dest-preview em`, `.field > label`), not classes — the class grep flags them; ignore.
- `.stage` (page padding wrapper in DownloadsTray + MobileSheet) is design-spec scaffolding that survives the scaffolding cut; not in the header on purpose.

## Gotchas
- Cards must size themselves with CSS only (no ResizeObserver / measurement scripts) and carry
  their own `<meta name="viewport">` — Claude Design serves raw files inside a host frame.
- Adding a card set: new `@dsCard` cards under `docs/designs/<set>/`, add the folder to
  `cfg.cardSets`, prefix its tokens and classes, add a `PROMPTS` entry per card in
  `build-cards.mjs` (the `@dsCard` subtitle is the fallback prompt) and a vocabulary section in
  `conventions.md`. Keep "|" out of card names and subtitles where you can (the generator
  escapes it for the README table, but it still reads badly).
- Folder names come from the filename minus its numeric prefix (`01-modal-network` → `ModalNetwork`);
  renaming a card file orphans the old remote folder — the reconciliation delete pass handles it.
