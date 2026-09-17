# design-sync notes (mStream)

Project: **mStream design cards** — https://claude.ai/design/p/9bec91f3-4103-41ed-866e-5e9731e19f6d
(created 2026-09-16 by the first sync; `projectId` is pinned in config.json).

## Shape: off-script, hand-authored cards
- mStream's webapp (`webapp/`) is Vue + plain JS, not a React component library, so the
  converter (`package-build.mjs`) has nothing to compile. `.design-sync/build-cards.mjs`
  produces the upload layout directly from the `@dsCard` HTML cards under `cfg.cardsDir`
  (today `docs/designs/discover-modal`). `pkg: "."` in config.json only marks the sync as
  completed; there is no package to install.
- `_ds_bundle.js` is an empty `window.MStream` namespace with an honest `components: []`
  header. `_ds_bundle.css` + `tokens/tokens.css` are cut from the cards' shared `<style>`
  block (the generator refuses to build if the cards' first `<style>` blocks differ).
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

## Known validate warns (legitimate)
- `_ds_sync.json absent` — see above.
- `tokens: 2 missing` = `--c` and `--pct`, per-element inline variables on `.dm-matchbar` /
  progress bars (`style="--pct:92%;--c:#657ee4"`), not design tokens.
- `.d.ts parse check skipped` — there are no `.d.ts` files in this shape.

## Gotchas
- Cards must size themselves with CSS only (no ResizeObserver / measurement scripts) and carry
  their own `<meta name="viewport">` — Claude Design serves raw files inside a host frame.
- Adding a card set: new `@dsCard` cards under `docs/designs/<set>/`, point `cfg.cardsDir` at it
  (or extend the generator to take several dirs), add a `PROMPTS` entry per card in
  `build-cards.mjs` (the `@dsCard` subtitle is the fallback prompt).
- Folder names come from the filename minus its numeric prefix (`01-modal-network` → `ModalNetwork`);
  renaming a card file orphans the old remote folder — the reconciliation delete pass handles it.
