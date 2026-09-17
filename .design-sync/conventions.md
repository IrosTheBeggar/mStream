# How to build with mStream's design cards

**This is a reference set of screens, not a component library.** `window.MStream` exports nothing. Build every screen with plain HTML and CSS, styled only through the tokens and classes below. Do not invent class names or colours: everything the cards use is in `styles.css` and its two imports, `tokens/tokens.css` and `_ds_bundle.css`. Read those two files before styling anything.

## Setup

No provider or wrapper is needed. Load `styles.css`; the page background is the ink colour and text defaults to `--t2` on it. The app is dark-only. Type is the system stack in `--font`; code, ISRCs and keyboard hints use `--mono`.

## Tokens (`tokens/tokens.css`, always `var(--name)`)

| Family | Tokens | Use |
| --- | --- | --- |
| Surfaces | `--ink` `--win` `--well` `--well-2` `--chip` `--chip-h` | page ground · modal window · option rows · icon tiles, progress tracks, the selector track · chips (and hover) |
| Lines | `--line` `--line-2` | section dividers · borders and ghost-button outlines |
| Text | `--t1` `--t2` `--t3` `--t4` `--t5` | brightest to dimmest: titles · body · secondary · labels, meta · hints |
| Source accents | `--teal` `--teal-2` · `--amber` `--amber-2` · `--blue` `--blue-2` | network rows · peer rows · library rows (base · hover) |
| Status | `--green` `--red` | success · error, danger |
| Current source | `--src` `--src-2` | set by the source class on the window; use these, not a fixed accent, for anything that should follow the row's origin |
| Type | `--font` `--mono` | system UI stack · monospace |

## Class vocabulary (`_ds_bundle.css`)

- **Window:** `dm` plus exactly one source class, `dm-network`, `dm-peer` or `dm-local`, which sets `--src`. Parts: `dm-close` (top right), `dm-tools` (small icon buttons under it — copy title), `dm-head` > `dm-art` (`dm-art-real` when artwork exists) + `dm-head-text` > `dm-title`, `dm-artist`, `dm-meta` (with `dm-isrc`), `dm-source` (with `dm-dot`, `dm-matchbar`), optional `dm-status` (peer online · last seen, from the peers listing).
- **View selector (peer rows only):** `dm-tabs` > two `dm-tab`s, the active one `dm-tab-on`; Federation first, Plug-Ins second. Network rows have no selector.
- **Sections:** `dm-section` > `dm-section-h` > `dm-label` (uppercase, optional icon) + `dm-hint`; body rows; optional `dm-note`. There is no action bar and no footer: a section's first row carries its primary button.
- **Option rows:** `opt` > `opt-ic` (`opt-ic-on` when active, `opt-ic-ok`, `opt-ic-err`) + `opt-body` > `opt-title`, `opt-sub` + `opt-act` (buttons). `opt-wrap` puts the buttons on their own line under the text (use it whenever a row carries three); `opt-muted` dims a row; `progress` (`progress-indet` for unknown length) under a running row; `attrib` for provider credit lines.
- **Buttons:** `btn` (secondary, default) with `btn-primary` (source-coloured), `btn-ghost`, `btn-danger`, `btn-sm`, `btn-icon`, `is-disabled`.
- **Chips and tags:** `chips` > `chip` (`chip-canon` outlined blue for canonical links); `tag` with `tag-soon` (amber PLANNED), `tag-sug` (blue SUGGESTED), `tag-ok`, `tag-err`, `tag-src`.
- **Collection destination (peer rows that carry Add rows):** `dm-dest` under the selector > folder icon + `path` (`b` = the library, `i` = the › separators) + a `tag` (`library default`, or `tag-src` for a saved one) + `opt-act` (Change…, reset). The picker replaces the bar in place: `dest-form` > `field` (`label` + `field-body` holding `select`, `input` (`is-err`, `caret`) or `static`) with `toks` > `tok` (`tok-new` for a variable still to build, `tok-preset` for the library template), `field-hint` / `field-err`, `tree` > `tree-crumb` + `tree-row` (`tree-row-on`) for Browse…; then `dest-preview` (`b` = the rendered layout, `s` / `em` for dropped or counted parts) and `dest-act` (with a `spacer` note). The layout syntax is the torrent path-template engine’s: `{{ARTIST}}/{{ALBUM}}`.
- **Misc:** `kbd` for key hints, `dashed` for an empty-state box.

## Idiomatic snippet (from the ModalPeer card)

```html
<div class="dm dm-peer">
  <a class="dm-close"></a>
  <div class="dm-tools"><a class="btn btn-sm btn-ghost btn-icon" title="Copy title"></a></div>
  <div class="dm-head">
    <div class="dm-art dm-art-real"></div>
    <div class="dm-head-text">
      <div class="dm-title">Paper Lanterns</div>
      <div class="dm-artist">Marlowe Vale · Night Ferry</div>
      <div class="dm-meta"><span>2019</span><span>3:48</span><span>FLAC</span></div>
      <div class="dm-source"><span class="dm-dot"></span>From your peers · Sam’s server (paired)</div>
      <div class="dm-status"><i></i>Sam’s server online · last seen 2 min ago</div>
    </div>
  </div>
  <div class="dm-tabs"><a class="dm-tab dm-tab-on">Federation</a><a class="dm-tab">Plug-Ins</a></div>
  <div class="dm-section">
    <div class="dm-section-h"><span class="dm-label">This song</span><span class="dm-hint">streams through your server</span></div>
    <div class="opt opt-wrap"><div class="opt-ic opt-ic-on"></div><div class="opt-body"><div class="opt-title">Paper Lanterns</div><div class="opt-sub">FLAC · 3:48</div></div><div class="opt-act"><button class="btn btn-sm btn-primary">Play now</button><button class="btn btn-sm">Queue next</button><button class="btn btn-sm">Add to queue</button></div></div>
    <div class="opt"><div class="opt-ic"></div><div class="opt-body"><div class="opt-title">Add to your collection</div><div class="opt-sub">Copies the file into your library · 28 MB</div></div><div class="opt-act"><button class="btn btn-sm">Add</button></div></div>
  </div>
</div>
```

Rules the cards encode: a row exists only when the plug-in or service behind it exists and is configured — nothing is ever shown locked or greyed; no action bar and no footer; peer rows open on the Federation view with a Federation | Plug-Ins selector, network rows have no selector; the option row itself shows job state (queued, running with `progress`, done, failed) rather than opening anything else; previews, downloads, copies and hand-offs only start on an explicit press; "collection" means the user's own library, and every Add row copies into the destination the `dm-dest` bar shows (default `{{ARTIST}}/{{ALBUM}}`, editable in place — see the CollectionDestination card). See the FlowAndRules card before adding a section.
