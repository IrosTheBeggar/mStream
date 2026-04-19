// Library scan progress endpoint.
//
// Authenticated (not admin-only). Rows are filtered to the vpaths the caller
// can see — admins additionally see pre-vpath "counting" rows where the
// scanner hasn't assigned a library yet.
//
// The backing `scan_progress` table is written live by the scanner
// (src/db/scanner.mjs) and cleared by task-queue.js when a scan finishes.

import path from 'path';
import * as db from '../db/manager.js';

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
}
