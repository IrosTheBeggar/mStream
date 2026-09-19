// Discovery plug-in jobs — the acquire / hand-off half of the plug-in API.
//
//   POST /api/v1/discovery/plugins/:name/jobs    start a job for one recommendation
//   GET  /api/v1/discovery/plugin-jobs           the caller's jobs (admins: ?all=1)
//   GET  /api/v1/discovery/plugin-jobs/:id       one job
//   POST /api/v1/discovery/plugin-jobs/:id/cancel
//   POST /api/v1/discovery/plugin-jobs/:id/keep   move a finished download into the collection
//
// A download's expiry is computed on every read from the current retention
// setting (never stored): `result.expiresAt` is present while the file is
// neither kept nor removed, and null when downloads never expire.
//
// Starting a job is gated twice: the plug-in must be on and runnable, and
// the acquisition gate must admit the caller — config.discoveryJobs.enabledFor
// 'all', or 'whitelist' with users.allow_discovery_jobs = 1 (the torrent
// integration's pattern). Reading and cancelling are owner-only; an admin
// sees everyone's.
//
// The same (plug-in, recommendation) is never queued twice while a job for
// it is live: the second ask answers 200 with the existing job instead of
// 202 with a new one.

import Joi from 'joi';
import * as plugins from '../discovery-plugins/index.js';
import * as runner from '../discovery-plugins/jobs.js';
import * as jobsDb from '../db/discovery-plugin-jobs.js';
import * as downloads from '../discovery-plugins/downloads.js';
import * as destinations from '../discovery-plugins/destination.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isAdmin(user) { return !!(user && user.admin === true); }

// A job as clients see it: a live download carries its expiry.
function present(job) {
  if (!job || !job.result || !job.result.downloaded || job.result.kept || job.result.removed) { return job; }
  return { ...job, result: { ...job.result, expiresAt: downloads.expiresAt(job.finishedAt) } };
}

export function checkJobsAccess(user) {
  const gate = (config.program && config.program.discoveryJobs) || {};
  if (gate.enabledFor === 'whitelist' && !(user && user.allow_discovery_jobs === 1)) {
    throw new WebError('you are not allowed to start discovery jobs on this server', 403);
  }
}

function ownJob(req) {
  const jobId = Number(req.params.id);
  if (!Number.isInteger(jobId) || jobId <= 0) { throw new WebError('job not found', 404); }
  const job = jobsDb.getJob(jobId);
  // Owner or admin; anyone else gets the same 404 as a missing job, so ids
  // can't be enumerated for other users' activity.
  if (!job || (!isAdmin(req.user) && job.userId !== (req.user ? req.user.id : null))) {
    throw new WebError('job not found', 404);
  }
  return job;
}

export function setup(mstream) {
  mstream.post('/api/v1/discovery/plugins/:name/jobs', (req, res) => {
    const name = String(req.params.name || '');
    const plugin = NAME_RE.test(name) ? plugins.getPlugin(name) : null;
    // Unknown, disabled and unavailable (its probe failed — no yt-dlp) all
    // read the same: the plug-in is not here.
    if (!plugin || !plugins.isPluginEnabled(name) || plugins.isPluginUnavailable(name)) {
      throw new WebError('unknown discovery plug-in', 404);
    }
    if (!plugin.capabilities.some((c) => plugins.RUNNABLE_CAPABILITIES.includes(c))) {
      throw new WebError(`plug-in ${name} does not run jobs — use resolve`, 400);
    }
    checkJobsAccess(req.user);

    const schema = Joi.object({ recommendation: plugins.recommendationSchema.required() });
    const { value: { recommendation } } = joiValidate(schema, req.body);
    const { job, created } = jobsDb.createJob({
      plugin: name,
      userId: req.user ? req.user.id : null,
      key: plugins.recommendationKey(recommendation),
      recommendation,
    });
    if (created) { runner.kick(); }
    res.status(created ? 202 : 200).json({ job: present(job), created });
  });

  mstream.get('/api/v1/discovery/plugin-jobs', (req, res) => {
    const schema = Joi.object({
      state: Joi.string().valid(...Object.values(jobsDb.JOB_STATES)).optional(),
      all: Joi.boolean().truthy('1').falsy('0').default(false),
      limit: Joi.number().integer().min(1).max(500).default(100),
    });
    const { value } = joiValidate(schema, req.query || {});
    const everyone = value.all === true && isAdmin(req.user);
    const jobs = jobsDb.listJobs({
      userId: everyone ? undefined : (req.user ? req.user.id : null),
      states: value.state ? [value.state] : null,
      limit: value.limit,
    });
    res.json({ jobs: jobs.map(present), runner: { running: runner.runningCount(), active: runner.isRunning() } });
  });

  mstream.get('/api/v1/discovery/plugin-jobs/:id', (req, res) => {
    res.json({ job: present(ownJob(req, req.params.id)) });
  });

  mstream.post('/api/v1/discovery/plugin-jobs/:id/cancel', (req, res) => {
    const job = ownJob(req, req.params.id);
    const outcome = jobsDb.requestCancel(job.id);
    if (outcome === null) {
      throw new WebError(`job ${job.id} is already ${job.state}`, 409);
    }
    res.json({ job: present(jobsDb.getJob(job.id)), outcome });
  });

  // Keep…: a finished download leaves the scratch library for the caller's
  // collection destination (or the one-off destination in the body). The
  // file moves, the library row follows, playlists that pointed at the old
  // path are rewritten, and the job records where it went.
  mstream.post('/api/v1/discovery/plugin-jobs/:id/keep', async (req, res) => {
    const job = ownJob(req, req.params.id);
    const { value } = joiValidate(Joi.object({
      destination: destinations.destinationSchema.optional(),
    }), req.body || {});
    if (job.state !== jobsDb.JOB_STATES.DONE || !job.result || !job.result.downloaded) {
      throw new WebError(`job ${job.id} has no download to keep`, 400);
    }
    if (job.result.kept) { throw new WebError(`job ${job.id} was already kept at ${job.result.kept.filepath}`, 409); }
    if (job.result.removed) { throw new WebError(`job ${job.id}'s download expired and was removed`, 409); }
    if (!destinations.uploadsAllowed(req.user)) { throw new WebError('Uploading Disabled', 403); }
    const destination = value.destination
      ? destinations.validateDestination(value.destination, req.user)
      : destinations.getDestination(req.user);
    if (!destination) { throw new WebError('no library to keep the download in', 403); }
    const kept = await downloads.keepDownload({ job, user: req.user, destination });
    res.json({ job: present(kept) });
  });
}
