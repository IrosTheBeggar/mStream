# Discover · recommendation modal (design, 2026-09-16, revision 2.2)

Design cards for the UX change **"clicking a Discover row opens a modal with every
option"**. Network rows get the plug-in sections (Listen, Federate, Get it, Send to, Find
elsewhere); peer rows get a **Federation | Plug-Ins** selector whose Federation view holds
song, album and artist actions against the paired server. Planned options carry an amber
`PLANNED` tag; my own additions carry a blue `SUGGESTED` tag.

Rules the cards encode: a row exists only when the plug-in or service behind it exists and
is configured (nothing is ever shown locked); there is no action bar and no footer; the
option row itself shows job state. **Collection** (decided 16 Sep) means the user's own
library: Add copies files from the peer into a folder the user sets or chooses, default
`{{ARTIST}}/{{ALBUM}}`, shown in a destination bar under the selector (card 10).

Each `.html` file is standalone (styles and icons inlined). Open it in a browser.

| Card | What it shows |
| --- | --- |
| `00-tokens.html` | Colours, type, buttons, the view selector, tags and the destination form controls, lifted from `webapp/alpha/spa.css` |
| `01-modal-network.html` | The modal for a "From the network" row, annotated (hero) |
| `02-modal-peer.html` | The modal for a "From your peers" row, Federation view with the destination bar, annotated |
| `10-collection-destination.html` | Where copies land: the bar, the picker (library · base folder · layout), browse, validation, compilations, Keep…, hidden |
| `09-modal-peer-plugins.html` | The same peer modal with the selector on Plug-Ins |
| `03-get-it-states.html` | The download section in every job state, including a peer copy |
| `04-send-to-states.html` | The hand-off section: idle, not connected (row absent), sending, sent, failed |
| `05-listen-states.html` | Previews in every state, plus the peer song row |
| `06-mobile-sheet.html` | The network modal as a bottom sheet at 390 px |
| `07-downloads-tray.html` | Where jobs and peer copies live after the modal closes |
| `08-flow-and-rules.html` | Flow, views and sections, visibility rules, API additions, i18n keys, open questions |
| `index.html` | Review board: every card on one page, scaled to fit (also published as an artifact) |

**Push to Claude Design:** run `/design-sync` from an interactive `claude` terminal in
this repo; `.design-sync/config.json` already points at this folder. Every card's first line
is a `<!-- @dsCard … -->` marker, so the Design System pane can index them.

The outputs here are the source of truth; edit them directly.
