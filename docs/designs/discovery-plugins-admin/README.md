# Admin · Discovery Plugins panel (design, 2026-09-18, revision 2)

Design cards for a new view in the admin panel (`webapp/admin`), **Discovery Plugins**, directly
under *Discovery*. It answers one question for the operator: what can people on this server do
with a Discover recommendation, and who is allowed to?

One card, four tabs, in the Discovery view's own vocabulary (boxed status header, pill tabs):

- **Plug-ins** — every registered plug-in as a row (switch · title, capability and scope tags ·
  description · status and bracket links), grouped by the section of the recommendation window
  it feeds, in the window's order.
- **Jobs** — who may start a job (all users | whitelist, with each account's upload right beside
  its tick) and the runner's limits.
- **Downloads** — the Discover downloads scratch library: what is waiting, how big against the
  size cap, how old, per user; the retention clock and the cap; Sweep now.
- **Activity** — every account's jobs, newest first, with cancel and the reason behind a failure.

Decided 18 Sep 2026: the view sits under Discovery; four tabs; no "what leaves the server" line
(revision 1 drew one); plug-in defaults unchanged (previews on, YouTube off); Discover downloads
gets a size cap (5 GB by default, 0 = none).

Rules the cards encode: everything on the view is live (no APPLY, no restart note) and toasts;
a plug-in that cannot run says why in the probe's own words and is never shown to users; status
words are lower-case; nothing destructive happens without a sentence saying what it will do.

The look is read off the running admin panel (computed styles on the Discovery, Torrent and
Settings views): white Materialize cards on `#f2f2f2`, a `#333` sidebar set in Jura, Open Sans
Light body, inline Material colours. Classes and tokens are prefixed `adm-` / `--adm-` so this
set can share one Claude Design bundle with the dark Discover-window cards.

Each `.html` file is standalone (styles and icons inlined). Open it in a browser.

| Card | What it shows |
| --- | --- |
| `00-admin-tokens.html` | The admin vocabulary: colour, type, settings rows, bracket links, buttons, pills, tiles, status dots, switch, tick, radio, callouts, the plug-in row |
| `01-admin-plugins-panel.html` | The view, annotated (hero): nav entry, status header, tabs, the grouped plug-in list |
| `02-admin-plugin-rows.html` | A plug-in row in every state, including two planned shapes |
| `03-admin-plugin-settings.html` | The `[settings]` modal: YouTube (binary with a dry-run Test, format, size cap, results scored), iTunes |
| `04-admin-plugins-jobs.html` | Jobs tab: the gate, the whitelist, runner limits, a server with no users |
| `05-admin-plugins-downloads.html` | Downloads tab: tiles, retention, per-user use, Sweep now and its result, never used, never expires |
| `06-admin-plugins-activity.html` | Activity tab: the all-users jobs table, a failure opened, the empty state |
| `07-admin-plugins-phone.html` | The same view at 375 px |
| `08-admin-plugins-rules.html` | Where it lives, what is live, the API (built vs to build), i18n keys, open questions |
| `index.html` | Review board: every card on one page, scaled to fit (also published as an artifact) |

**Push to Claude Design:** run `/design-sync` from an interactive `claude` terminal in this repo.
`.design-sync/config.json` lists this folder next to `docs/designs/discover-modal`, and the
generator bundles both sets, so a re-sync adds these cards without removing the Discover ones.

The outputs here are the source of truth; edit them directly.
