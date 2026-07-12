// Library scan progress + enrichment status endpoints.
//
// Authenticated (not admin-only). Rows are filtered to the vpaths the caller
// can see — admins additionally see pre-vpath "counting" rows where the
// scanner hasn't assigned a library yet.
//
// The backing `scan_progress` table is written live by the scanner
// (src/db/scanner.mjs) and cleared by task-queue.js when a scan finishes.

import path from 'path';
import * as db from '../db/manager.js';
import * as dbQueue from '../db/task-queue.js';
import { getEnrichmentCoverage } from '../db/enrichment-status-lib.js';

export function setup(mstream) {
  mstream.get('/api/v1/scan/progress', (req, res) => {
    const userVpaths = Array.isArray(req.user?.vpaths) ? req.user.vpaths : [];
    const isAdmin = req.user?.admin === true;

    const rows = db.getDB().prepare('SELECT * FROM scan_progress').all();
    const visible = rows.filter(r => {
      if (!r.vpath) { return isAdmin; }
      return userVpaths.includes(r.vpath);
    });

    res.json(visible.map(r => ({
      vpath: r.vpath || 'Scanning…',
      pct: r.expected ? Math.min(100, Math.round((r.scanned / r.expected) * 100)) : null,
      scanned: r.scanned || 0,
      expected: r.expected || null,
      // basename only — never expose absolute server paths
      currentFile: r.current_file ? path.basename(r.current_file) : null,
    })));
  });

  // ── Enrichment status ─────────────────────────────────────────────────────
  //
  // One poll answers three questions per enrichment pass (waveforms,
  // album-art, lyrics, BPM/key, discovery embeddings, AcoustID):
  //
  //   Is it on?        enabled / disabledReason (config + environment gates)
  //   Is it working?   state (idle|queued|running|disabled) + live progress
  //                    from the worker's own progress events, plus a summary
  //                    of the last run this process lifetime
  //   How far along?   coverage — durable done/remaining/outcome counts from
  //                    the DB (they survive restarts; see
  //                    src/db/enrichment-status-lib.js)
  //
  // Authenticated like /scan/progress above, not admin-only: enrichment
  // explains player-visible features (missing waveform, missing lyrics,
  // no BPM pill), so every user gets to see it. Track/album-scoped
  // coverage counts are filtered to the caller's accessible libraries;
  // hash-keyed passes (waveform, discovery) are marked scope 'global'.
  // The queue block mirrors what admins see in the dashboard but carries
  // only task KINDS — no vpaths, no filepaths, nothing library-shaped.
  mstream.get('/api/v1/scan/status', (req, res) => {
    const stats = dbQueue.getAdminStats();
    const coverage = getEnrichmentCoverage(db.getUserLibraryIds(req.user));

    res.json({
      queue: {
        // isScanning() semantics: heavy disk work (scan or backup), the
        // same "locked" bit /db/status reports. Enrichment passes are
        // visible via activeTask/queued instead.
        scanning: dbQueue.isScanning(),
        activeTask: stats.activeTaskKind,
        queued: stats.taskQueue.map((t) => t.task),
      },
      totals: coverage?.totals || null,
      enrichment: dbQueue.getEnrichmentStatus().map((p) => ({
        ...p,
        coverage: coverage?.passes?.[p.pass] ?? null,
      })),
    });
  });
}
