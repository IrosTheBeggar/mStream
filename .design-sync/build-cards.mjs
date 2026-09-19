#!/usr/bin/env node
// Off-script design-sync generator for mStream's hand-authored design cards.
//
// mStream's webapp is not a React component library, so the design-sync
// converter (package-build.mjs) has nothing to compile. This script produces
// the same upload layout from the standalone `@dsCard` HTML cards under
// docs/designs/<set>/ so claude.ai/design can index them. Several sets can
// share one project (`cardSets` in config.json): each set has its own shared
// stylesheet, and because an upload reconciles deletes, EVERY set that should
// stay in the project must be listed — a set left out is removed remotely.
//
//   ds-bundle/
//     _ds_bundle.js           empty namespace + `@ds-bundle` header (no compiled components)
//     _ds_bundle.css          each set's shared CSS, concatenated (every card in a set inlines an identical copy)
//     styles.css              @imports tokens + _ds_bundle.css (the closure designs receive)
//     tokens/tokens.css       each set's `:root` custom properties (sets prefix theirs, e.g. --adm-*)
//     README.md               .design-sync/conventions.md + generated card index
//     components/<group>/<Name>/<Name>.html      verbatim card (first line = @dsCard marker)
//     components/<group>/<Name>/<Name>.prompt.md what the card shows, for the design agent
//     _ds_needs_recompile     upload sentinel ({"by":"design-sync-cli"}) - the app self-checks when it lands
//     .ds-build-meta.json     local-only build metadata
//
// No `_ds_sync.json` is written: the anchor's recipe keys on converter facts
// this layout does not have, so the honest choice is no anchor (every sync
// re-verifies everything - nine cards, cheap).
//
// Usage: node .design-sync/build-cards.mjs [--config .design-sync/config.json] [--out ./ds-bundle]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : dflt; };
const cfgPath = resolve(arg('--config', '.design-sync/config.json'));
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const OUT = resolve(arg('--out', cfg.out ?? './ds-bundle'));
// cardSets (several folders) wins over the older single cardsDir.
const setDirs = (Array.isArray(cfg.cardSets) && cfg.cardSets.length ? cfg.cardSets : [cfg.cardsDir ?? 'docs/designs/discover-modal']).map((d) => resolve(d));
const globalName = cfg.globalName ?? 'MStream';
const headerPath = cfg.readmeHeader ? resolve(cfg.readmeHeader) : null;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const log = (m) => console.error(m);

// Cards = every .html whose first line is the @dsCard marker (index.html, the
// review board, has none and is skipped on purpose).
const cards = [];
const sets = [];
for (const cardsDir of setDirs) {
const setCards = [];
const cardFiles = readdirSync(cardsDir).filter((f) => f.endsWith('.html')).sort();
for (const f of cardFiles) {
  const txt = readFileSync(join(cardsDir, f), 'utf8');
  const first = txt.split('\n', 1)[0];
  const m = /^<!--\s*@dsCard\s+([^>]*?)\s*-->/.exec(first);
  if (!m) { log(`  skip ${f} (no @dsCard first line)`); continue; }
  const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  // Folder name: PascalCase of the filename minus its ordering prefix
  // (01-modal-network.html -> ModalNetwork). Stable across re-syncs.
  const name = basename(f, '.html').replace(/^\d+-/, '').split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('');
  if (cards.some((c) => c.name === name)) { log(`  ${f}: a card named ${name} already exists in another set - folder names must be unique across sets`); process.exit(1); }
  const card = { file: f, txt, name, group: attrs.group ?? 'Design', attrs, set: basename(cardsDir) };
  cards.push(card);
  setCards.push(card);
}
if (!setCards.length) { log(`no @dsCard cards under ${cardsDir}`); process.exit(1); }
sets.push({ dir: cardsDir, label: basename(cardsDir), cards: setCards });
}

// Shared CSS: every card carries the same first <style> block. Take it from
// the first card and refuse to build if any card disagrees - the shipped
// stylesheet must be what the cards actually render with.
const styleOf = (txt) => /<style>([\s\S]*?)<\/style>/.exec(txt)?.[1] ?? '';
let tokensCss = '';
let compCss = '';
for (const set of sets) {
  const shared = styleOf(set.cards[0].txt);
  for (const c of set.cards) {
    if (styleOf(c.txt) !== shared) { log(`  ${set.label}/${c.file}: first <style> block differs from ${set.cards[0].file} - the set's cards no longer share one stylesheet; rebuild them all`); process.exit(1); }
  }
  const rootM = /:root\s*\{[\s\S]*?\n\}/.exec(shared);
  if (!rootM) { log(`no :root block in ${set.label}'s shared stylesheet`); process.exit(1); }
  tokensCss += `/* mStream · ${set.label} tokens (source: ${set.cards[0].file}, shared by every card in the set) */\n${rootM[0]}\n\n`;
  // Component CSS = everything after :root, minus the design-spec scaffolding
  // (annotation columns, grids, page headers) which is not part of the UI.
  let css = shared.slice(rootM.index + rootM[0].length);
  const cut = css.indexOf('/* ── design-spec scaffolding');
  if (cut > 0) css = css.slice(0, cut);
  compCss += `/* mStream · ${set.label} component classes (source: ${set.cards[0].file}, shared by every card in the set).\n   Tokens live in tokens/tokens.css. */\n${css.trim()}\n\n`;
}

// Per-card guidance for the design agent. Keyed by folder name; the @dsCard
// subtitle is the fallback so a new card never ships an empty prompt.
const PROMPTS = {
  Tokens: 'Colour, type, button, selector, tag and chip vocabulary for the Discover recommendation modal. Read this card first: every other card is built from these tokens (`tokens/tokens.css`) and classes (`_ds_bundle.css`).',
  ModalNetwork: 'The canonical recommendation modal for a "From the network" row (teal source colour). Header (title, artist · album, year, length, ISRC chip, match-to-seed bars, source line; a small copy-title icon under the close button) → sections by what exists and is configured: Listen (preview plug-ins), Federate (admins only: invite the anonymous peer to pair, via the federation request compose), Get it (acquire plug-ins), Send to (hand-off plug-ins), Find elsewhere (links). No action bar, no footer: each section’s first row carries its own primary button. A row exists only when the plug-in or service behind it exists and is configured; nothing is ever shown locked.',
  ModalPeer: 'The modal for a "From your peers" row (amber source colour) on its default Federation view. Header adds a status line (peer online, last seen — from the peers listing; the peer reports nothing about transfer limits) and a Federation | Plug-Ins selector (`dm-tabs`), then the destination bar (`dm-dest`: where copies land, resolved for this song, with Change…). Sections: This song (Play now · Queue next · Add to queue, plus Add to your collection), Album (View album · Play album · Add album to queue, plus Add album to your collection), Artist (View artist, Add artist to your collection, the suggested Add what you’re missing), More from the peer (suggested: More like this on the peer, Auto DJ from here). “Collection” is decided: the user’s own library — adding copies files from the peer, as a job, into the folder the bar shows (default `{{ARTIST}}/{{ALBUM}}`; see CollectionDestination).',
  CollectionDestination: 'Where collection copies land and how the user sets or chooses the folder. The bar under the view selector (library default vs. yours, Change…, reset), the in-place picker (library select limited to libraries the user may upload to · base folder with Browse… over the file explorer listing · layout template using the torrent path-template engine’s `{{ARTIST}}/{{ALBUM}}` syntax with token chips, a new `{{PEER}}` variable and a library-template preset · live preview resolved for this song · Use this folder), validation (unknown variable, empty tag), the compilation nudge toward `{{ALBUMARTIST}}`, the same picker as Keep… in Get it, the hidden case, and the storage and job rules (per-account user_settings, per-song rendering, skip owned, never overwrite, rows inserted like Youtube DL).',
  ModalPeerPlugins: 'The same peer modal with the selector on Plug-Ins: exactly the network row’s sections (Listen previews, Get it, Send to, Find elsewhere) minus Federate. Playing, queueing and copying the peer’s file live on the Federation view, so nothing here duplicates them.',
  GetItStates: 'The "Get it" (acquire) section in every job state: idle → queued → downloading with progress → done (Play · Queue · Keep…) / failed (Retry) / cancelled, plus a peer collection copy in its copying and in-collection states (same job rows, amber), and the hidden case: no plug-in, unconfigured plug-in, or downloads off for this account all mean the row is simply absent. The option row itself becomes the job; nothing opens elsewhere.',
  SendToStates: 'The "Send to" (hand-off) section: idle with every target configured, the not-connected case (a user-scoped service without this user’s token has no row; connecting happens in a Settings page whose user-settings routes are still to build), then sending → sent / failed / already there. One row per configured hand-off plug-in (ListenBrainz, Lidarr, webhook).',
  ListenStates: 'The "Listen" section: one row per preview provider (Deezer, iTunes) in idle → looking up → playing (main player pauses) → no preview / busy-or-failed states, plus the Federation view’s song row (Play now · Queue next · Add to queue; playing; peer offline). Previews fetch only on an explicit press.',
  MobileSheet: 'The network-row modal as a bottom sheet at 390 px: the same sections stacked, copy-title icon under the close button, no action bar, no footer. Use for any phone-width rendering of the recommendation modal.',
  DownloadsTray: 'Where jobs live after the modal closes: a compact strip at the bottom of the Discover panel listing running / ready / failed downloads and peer collection copies (amber) with the same row vocabulary as the Get it section. Planned; the alternative home is an Upload-window tab.',
  AdminTokens: 'The admin panel’s vocabulary (webapp/admin: Vue 2 on Materialize 1.x), read off the running app: page #f2f2f2, white 2px-radius cards with the Materialize shadow, a #333 sidebar in Jura, Open Sans Light 15px body, teal #26a69a buttons, #039be5 links, Material green / orange / red for status. Read this card before any admin card: settings rows ("Label: value … [edit]"), bracket links, the boxed status header with pill tabs and stat tiles from the Discovery view, the switch (live), the filled tick (per-row grant), radios, blue and amber callouts, toasts, and the one new component, the plug-in row. LIGHT theme only; never mix with the dark Discover-window classes (dm-*). Tokens are --adm-*, classes adm-*.',
  AdminPluginsPanel: 'The hero for the new admin view "Discovery Plugins": a nav entry under Config directly below Discovery (same cyan, plug icon), and ONE card holding a boxed status header (dot + one sentence: plug-ins on, how many cannot run, who may start jobs, what is running; [Refresh]) and four pill tabs — Plug-ins · Jobs · Downloads · Activity. The Plug-ins tab lists every registered plug-in as a row, grouped by the section of the recommendation window it feeds, in the window’s order (Listen, Get it, Send to, Find elsewhere). Everything is live: a switch applies at once and toasts; there is no APPLY button and no restart note.',
  AdminPluginRows: 'The plug-in row in every state: on; off (the text greys); switching (inert switch, then a toast); switch failed (springs back, server message in a toast); cannot run (enabled but the availability probe fails — the probe’s own reason in an amber block, [settings] and [check again]; users never see this row); still starting (the same state with a reason that clears by itself); and two PLANNED shapes — needs setup (a server-scoped hand-off with no target, inert switch, [set up]) and per-user with credentials (a "per user" scope tag and "2 of 8 users connected"). Anatomy: switch · title + capability tag + scope tag · description · status word and bracket links on the right. There is deliberately NO “what leaves the server” line on a row.',
  AdminPluginSettings: 'The modal behind [settings] (the admin’s usual Materialize modal): YouTube — yt-dlp binary with a Test button (a dry run of the availability probe against unsaved values), Save as (codec select), Largest download (MB), Search results to score, and a blue note about where downloads land; Test passing (version + ffmpeg ready), failing (the probe’s reason; Save stays allowed) and running; a refused value under its field with Save disabled; iTunes’ single Storefront field. One generic modal driven by a per-plug-in field table; saving is live and redraws the row behind it.',
  AdminPluginsJobs: 'The Jobs tab: "Who can start jobs" as two radios (All users | Whitelist) that apply at once — the Torrent view’s Enabled For pattern made live — with a blue note that copies and Keep… also need the account’s upload right; in whitelist mode a table User · Admin · Can upload · Discovery jobs (filled ticks, applied per click, toast); the runner’s two settings rows with [edit] (Jobs at once, Finished jobs kept for) and their modal; and a server with no users, where Whitelist is dimmed with its reason and an amber note says anyone who can open the server can download.',
  AdminPluginsDownloads: 'The Downloads tab for the Discover downloads scratch library: four stat tiles (downloads waiting · on disk AGAINST THE SIZE CAP with a thin bar and the free space · oldest download with days left · time until the next retention pass), three settings rows (remove downloads nobody kept after N days with [edit]; stop downloading above N GB with [edit], 0 = no cap; the folder, read-only because it is a config-file change), the FULL state (orange tile and a reason block: new downloads are refused with “Discover downloads is full”), a per-user table (waiting, size, oldest, newest), and Sweep now in the card’s action strip with its running and result states ("Removed 2 expired downloads and 1 partial file…", "Nothing had expired"). Also: never used (library not created yet), never expires (retention 0), and the retention modal, which names how many files a shorter clock makes due.',
  AdminPluginsActivity: 'The Activity tab: every account’s plug-in jobs, newest first, last 100. A status line (running of allowed, waiting), filter pills (All · Live · Failed) and a table When · User · Plug-in · Recommendation · State · action. Rows: downloading / copying with a progress bar and a red [cancel]; queued; failed with [why] opening the job’s error verbatim in a code block plus one plain sentence for recognised causes; kept and copied with where the file went; downloaded with days left; skipped; cancelled (muted). State words are the user window’s own (shared jobRowState). Empty state included.',
  AdminPluginsPhone: 'The same admin view at 375 px, three screens: Plug-ins (a row wraps so status and bracket links sit under the text; pills may wrap to two lines), Jobs with the whitelist as stacked rows (name and tick on one line, rights underneath), and Activity as two-line stacked jobs with the failure reason opening in place. The admin’s sidebar is off-canvas behind its red floating menu button; containers run at 90 %.',
  AdminPluginsRules: 'Read before building the admin view: where it lives (nav, one card with four tabs, what loads when, what polls), what is live and the one thing that is not (the downloads folder), the API it stands on with built vs to-build routes (status, plug-in settings on the switch route, a dry-run probe, downloadsRetentionDays and downloadsMaxSizeMb, allowDiscoveryJobs in the users list, username on the admin jobs list, registry adminSettings and probe detail), the i18n key families (admin.dplugins.*), and what was decided on 18 Sep 2026 (under Discovery · four tabs · no “what leaves the server” line · defaults unchanged · a size cap) plus the one thing still assumed (live controls, no APPLY).',
  FlowAndRules: 'Row → window → action → job flow, the source → view → section map (network sections, peer Federation view, Plug-Ins view), the hide-when-unavailable visibility rules, behaviour (selector memory, close never cancels a job), the API additions needed (peer health reporting limits, accepts-requests flag, may-create-jobs flag, user-settings routes), the i18n keys the webapp will need (now including the dest.* picker keys), the decided collection semantics, and open questions (copy policy on the peer, library rows, tray home, preview defaults). Read before adding a section or a row.',
};

// Fresh output tree.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'tokens'), { recursive: true });
writeFileSync(join(OUT, 'tokens', 'tokens.css'), tokensCss);
writeFileSync(join(OUT, '_ds_bundle.css'), compCss);
writeFileSync(join(OUT, 'styles.css'), `/* mStream design cards · styles entry point (rendered designs receive this file's @import closure) */\n@import "./tokens/tokens.css";\n@import "./_ds_bundle.css";\n`);

const sourceHashes = {};
const index = [];
for (const c of cards) {
  const dir = join(OUT, 'components', c.group, c.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${c.name}.html`), c.txt);
  const prompt = `${c.attrs.name ?? c.name} — ${c.attrs.subtitle ?? ''}`.trim() + `\n\n${PROMPTS[c.name] ?? c.attrs.subtitle ?? c.name}\n\nSource card: docs/designs/${c.set}/${c.file} (standalone HTML; styles inlined). Card size: ${c.attrs.width ?? '?'}×${c.attrs.height ?? '?'} px.\n`;
  writeFileSync(join(dir, `${c.name}.prompt.md`), prompt);
  sourceHashes[c.name] = sha(c.txt).slice(0, 12);
  // A "|" inside a name or subtitle would split the README table's row.
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|');
  index.push(`| \`${c.group}/${c.name}\` | ${cell(c.attrs.name ?? c.name)} | ${cell(c.attrs.subtitle)} |`);
}

// _ds_bundle.js: a syntactically valid IIFE with the header the app's
// self-check parses. `components: []` is the truth - nothing is compiled.
const header = { namespace: globalName, components: [], sourceHashes, inlinedExternals: [], shape: 'hand-authored-cards' };
writeFileSync(join(OUT, '_ds_bundle.js'), `/* @ds-bundle: ${JSON.stringify(header).replace(/\*\//g, '*\\/')} */\n(function(){ window.${globalName} = window.${globalName} || {}; })();\n`);

// README: conventions header (human-authored) + generated body.
const head = headerPath && existsSync(headerPath) ? readFileSync(headerPath, 'utf8').trim() + '\n\n' : '';
const body = `# mStream · design cards

Hand-authored design cards for mStream (\`webapp/\`: the player and the admin panel), synced from ${sets.map((x) => `\`docs/designs/${x.label}/\` (${x.cards.length})`).join(' and ')}.
There is no compiled component bundle: \`window.${globalName}\` is empty. The cards are the reference; the
stylesheets (\`styles.css\` → \`tokens/tokens.css\` + \`_ds_bundle.css\`) are the real CSS every card renders with.

## Cards

| Component | Card | Shows |
| --- | --- | --- |
${index.join('\n')}

Each \`components/<group>/<Name>/<Name>.prompt.md\` says what its card shows and when to use it.
`;
writeFileSync(join(OUT, 'README.md'), head + body);
const readmeSize = Buffer.byteLength(head + body);
if (Buffer.byteLength(head) > 31900) log(`  ! README header is ${Buffer.byteLength(head)} B (> ~31.9k) - shorten .design-sync/conventions.md`);
else if (readmeSize > 32000) log(`  ! README body tail past ~32k (${readmeSize} B) will be cut inline`);

writeFileSync(join(OUT, '_ds_needs_recompile'), JSON.stringify({ by: 'design-sync-cli' }) + '\n');
writeFileSync(join(OUT, '.ds-build-meta.json'), JSON.stringify({ shape: 'off-script', generator: '.design-sync/build-cards.mjs', cardSets: sets.map((x) => x.label), componentCount: cards.length, globalName }, null, 2) + '\n');
log(`  built ${cards.length} card(s) into ${OUT} (tokens ${tokensCss.length} B, component CSS ${compCss.length} B, README ${readmeSize} B)`);
