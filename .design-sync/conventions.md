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

---

# Second set: the admin panel (group `Admin`, light)

Two card sets share this project and they never mix. The **Discover window** above is the player: dark, `dm-*` / `opt` / `btn` classes, un-prefixed tokens. The **admin panel** (`webapp/admin`, Vue 2 on Materialize 1.x) is light, and everything it uses is prefixed: tokens `--adm-*`, classes `adm-*`. Pick the set by the screen you are drawing; never put a `dm-*` class on an admin screen or an `adm-*` class in the window.

## Admin setup

Put `class="adm-page"` on `<body>` (page ground `--adm-page`, Open Sans Light 15 px, links `--adm-link`). A full screen is `adm-app` > `adm-side` (the `#333` sidebar: `adm-logo`, `adm-side-h` group labels, `adm-nav` items with a 28 px icon, the selected one `adm-nav-on`) + `adm-content` > `adm-container`. A view is a column of cards.

## Admin tokens

| Family | Tokens | Use |
| --- | --- | --- |
| Surfaces | `--adm-page` `--adm-card` `--adm-side` `--adm-pill` | page · card · sidebar · selected nav item and active pill tab |
| Text | `--adm-ink` `--adm-ink-2` `--adm-ink-3` `--adm-ink-4` `--adm-side-ink` | body · status lines · captions · hints and brackets · sidebar text |
| Lines | `--adm-line` `--adm-rule` | boxes, tiles, pill borders · table row rules |
| Action | `--adm-teal` `--adm-teal-2` `--adm-link` | buttons, switch, tick (base · hover) · links |
| Status | `--adm-green` `--adm-orange` `--adm-red` `--adm-red-2` `--adm-grey` `--adm-badge` | ok · needs attention · failed · destructive link · off · BETA badge |
| Callouts | `--adm-info-bg` `--adm-info-line` `--adm-warn-bg` `--adm-warn-line` | blue info · amber heads-up |
| Type | `--adm-font` `--adm-nav-font` `--adm-mono` | Open Sans · Jura (sidebar only) · monospace for paths, commands, config keys |

## Admin class vocabulary

- **Card:** `adm-card` > `adm-card-content` (24 px) > `adm-card-title` (24 px / 300, may hold an `adm-badge`); a card's one main button sits right in `adm-card-action`. Text helpers: `adm-lead`, `adm-sub` (0.9 em grey captions such as “Changes apply immediately.”), `adm-muted`, `adm-mono`.
- **Settings rows:** `table.adm-rows` > `tr` > `td` “**Label:** value” with an optional `adm-note` under it, and a last `td` holding a bracket link. **Bracket links:** `<span class="adm-br">[<a>edit</a>]</span>`; brackets stay grey, a destructive link adds `adm-danger`.
- **Status header (from the Discovery view):** `adm-box` > `adm-box-h` > `adm-status` (an `adm-dot` with `adm-dot-ok|warn|err`, then a lower-case status word in `adm-ok|warn|err|off`, then plain spans) + `adm-box-act` (bracket links). Tabs are `adm-pills` > `adm-pill`, the active one `adm-pill-on`; a `<small>` inside a pill is its count. Stat tiles: `adm-tiles` > `adm-tile` > `adm-tile-n` (number, units in `<small>`), `adm-tile-l`, `adm-tile-s`.
- **Tables:** `table.adm-table` (`adm-num` right-aligns a column, `adm-muted` on a `tr` dims it, `tr.adm-detail` is an opened row holding a `code` block).
- **Controls:** `adm-switch` (`adm-switch-on`, `adm-switch-busy`) for anything that applies at once; `adm-check` (`adm-check-on`, `adm-check-off`) for a per-row grant; `adm-radio` (`adm-radio-on`, `adm-radio-off` dimmed with its reason in the sentence) for one-of, written “**Choice** — what it means”. Form fields in modals: `adm-field` > `label` + `adm-input` (`adm-input-focus`, `adm-input-err`, an `adm-unit` on the right, `adm-caret`) or `adm-select`, then `adm-help` (`adm-help-err`, `adm-help-ok`).
- **Buttons:** `adm-btn` (teal, uppercase) with `adm-btn-green`, `adm-btn-flat` (modal footers, inline Test), `is-disabled`.
- **Tags and badges:** `adm-tag` (capability: links · preview · play · acquire · handoff), `adm-tag-user` (scope “per user”), `adm-tag-new` (planned / to build), `adm-badge` (orange BETA).
- **Callouts:** `adm-callout` (blue info), `adm-callout-warn` (amber), `adm-callout-err`; `adm-reason` (amber block with the server's own reason, `adm-reason-err` for red); `adm-toast` (`adm-toast-ok`, `adm-toast-err`); `adm-progress` (`adm-progress-indet`).
- **Modal:** `adm-modal` > `adm-modal-content` (an `h4` title) + `adm-modal-footer` (flat buttons, Save in teal text).
- **Plug-in list (the one new component):** `adm-group` (a `b` section label + a grey `span` hint) then rows `adm-plugin` (`adm-plugin-off` greys the text) > `adm-plugin-sw` (the switch) + `adm-plugin-body` > `adm-plugin-h` (title in `b`, tags), `adm-plugin-d` (description), optional `adm-plugin-meta` (one grey fact line, e.g. “2 of 8 users connected”), optional `adm-reason` + `adm-plugin-act` (status, then bracket links, right-aligned).

## Admin snippet (from the AdminPluginsPanel card)

```html
<div class="adm-card"><div class="adm-card-content">
  <span class="adm-card-title">Discovery Plugins</span>
  <div class="adm-box">
    <div class="adm-box-h">
      <div class="adm-status"><span class="adm-dot adm-dot-warn"></span><span class="adm-warn">5 of 6 plug-ins on, 1 cannot run</span><span>· jobs open to <b>all users</b></span></div>
      <div class="adm-box-act"><span class="adm-br">[<a>Refresh</a>]</span></div>
    </div>
    <div class="adm-pills"><div class="adm-pill adm-pill-on">Plug-ins</div><div class="adm-pill">Jobs</div><div class="adm-pill">Downloads</div><div class="adm-pill">Activity<small>2</small></div></div>
    <div class="adm-group"><b>Get it</b><span>runs as a job · gated by the Jobs tab</span></div>
    <div class="adm-plugin">
      <span class="adm-plugin-sw"><span class="adm-switch adm-switch-on"><i></i></span></span>
      <div class="adm-plugin-body">
        <div class="adm-plugin-h"><b>YouTube</b><span class="adm-tag">acquire</span></div>
        <div class="adm-plugin-d">Saves the best-matching upload’s audio into Discover downloads with yt-dlp.</div>
        <div class="adm-reason"><span><b>Cannot run:</b> yt-dlp not found (<code>yt-dlp</code>).</span></div>
      </div>
      <div class="adm-plugin-act"><span class="adm-status"><span class="adm-dot adm-dot-warn"></span><span class="adm-warn">cannot run</span></span><span class="adm-br">[<a>settings</a>]</span><span class="adm-br">[<a>check again</a>]</span></div>
    </div>
  </div>
</div></div>
```

Rules the admin cards encode: everything on the Discovery Plugins view applies at once and toasts — no APPLY button, no restart note (the one non-live value, the downloads folder, is shown read-only); status words are lower-case (`on`, `off`, `cannot run`, `needs setup`, `saving…`); a plug-in that cannot run shows the probe's own reason to the admin and is never shown to users; a row carries no “what leaves the server” line (decided against); Discover downloads has a size cap as well as a clock, and “full” is an orange state with its reason; nothing destructive happens without a sentence saying what it will do. See the AdminPluginsRules card before adding a tab or a row state.
