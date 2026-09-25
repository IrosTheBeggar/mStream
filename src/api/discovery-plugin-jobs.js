// Discovery plug-in jobs — the acquire / hand-off half of the plug-in API.
//
//   POST /api/v1/discovery/plugins/:name/jobs    start a job for one recommendation
//   GET  /api/v1/discovery/plugin-jobs           the caller's jobs (admins: ?all=1)
//   GET  /api/v1/discovery/plugin-jobs/:id       one job
//   POST /api/v1/discovery/plugin-jobs/:id/cancel
//   POST /api/v1/discovery/plugin-jobs/lookup     the caller's newest job per plug-in for one recommendation
//   POST /api/v1/discovery/plugin-jobs/clear      drop the caller's finished rows ("Clear finished")
//
// Starting a job is gated three times: the plug-in must be on and runnable,
// the acquisition gate must admit the caller — config.discoveryJobs.enabledFor
// 'all', or 'whitelist' with users.allow_discovery_jobs = 1 (the torrent
// integration's pattern) — and an acquire plug-in's job, which lands a file
// in a library, needs the caller's upload right as the REQUEST carries it
// (the job runs later under the account's own rights, which may be wider:
// a jukebox token is the account with its writes switched off). Reading and
// cancelling are owner-only; an admin sees everyone's.
//
// None of it is for a jukebox session: a remote-control guest holds the
// owner's account with no writes, and every plug-in route here acts on the
// account itself (auth.js buildJukeboxUser marks the user; refuseJukebox
// sits in front of every discovery plug-in route).
//
// The same (plug-in, recommendation) is never queued twice while a job for
// it is live: the second ask answers 200 with the existing job instead of
// 202 with a new one. When the live job is somebody else's the caller gets a
// 409 rather than a row they could not read again.

import Joi from 'joi';
import * as plugins from '../discovery-plugins/index.js';
import * as runner from '../discovery-plugins/jobs.js';
import * as jobsDb from '../db/discovery-plugin-jobs.js';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import * as destinations from '../discovery-plugins/destination.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isAdmin(user) { return !!(user && user.admin === true); }

// The acquisition gate as a yes/no — the plug-in listing carries it so a
// client hides what the caller could only be refused.
export function jobsAllowed(user) {
  const gate = (config.program && config.program.discoveryJobs) || {};
  return !(gate.enabledFor === 'whitelist' && !(user && user.allow_discovery_jobs === 1));
}

export function checkJobsAccess(user) {
  if (!jobsAllowed(user)) {
    throw new WebError('you are not allowed to start discovery jobs on this server', 403);
  }
}

// A file a plug-in lands in a library is an upload by another road: the
// server switch and the caller's allow_upload both apply, at the request
// (the job's later run re-checks the account, but the account's rights are
// not always the request's — see buildJukeboxUser).
export function checkUploadRight(user) {
  if (!destinations.uploadsAllowed(user)) {
    throw new WebError('Uploading Disabled', 403);
  }
}

// Express middleware for a route prefix: a jukebox session token reaches no
// discovery plug-in route at all.
export function refuseJukebox(req, res, next) {
  if (req.user && req.user.jukebox === true) {
    throw new WebError('not available in a jukebox session', 403);
  }
  next();
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
  mstream.use('/api/v1/discovery/plugin-jobs', refuseJukebox);

  mstream.post('/api/v1/discovery/plugins/:name/jobs', (req, res) => {
    refuseJukebox(req, res, () => {});
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
    if (plugin.capabilities.includes(plugins.CAPABILITIES.ACQUIRE)) { checkUploadRight(req.user); }

    const schema = Joi.object({
      recommendation: plugins.recommendationSchema.required(),
      // What the job acts on (plugins.JOB_SCOPES): the song unless the
      // plug-in declares wider scopes and the caller asks for one.
      scope: Joi.string().valid(...Object.values(plugins.JOB_SCOPES)).optional(),
      // An upload the caller picked from the plug-in's lookup: the job
      // fetches that one instead of searching. Only a plug-in with a
      // lookup takes one, and it checks the link itself (validateChoice).
      choice: Joi.object({ url: Joi.string().uri({ scheme: ['http', 'https'] }).max(2048).required() }).optional(),
    });
    const { value: { recommendation, scope: askedScope, choice } } = joiValidate(schema, req.body);
    const scope = askedScope || plugins.JOB_SCOPES.SONG;
    if (!plugin.scopes.includes(scope)) {
      throw new WebError(`plug-in ${name} has no "${scope}" scope (it has: ${plugin.scopes.join(', ')})`, 400);
    }
    const missing = plugins.scopeMissing(recommendation, scope);
    if (missing) { throw new WebError(`a ${scope} job needs the recommendation's ${missing}`, 400); }
    if (choice) {
      if (!plugin.capabilities.includes(plugins.CAPABILITIES.LOOKUP)) {
        throw new WebError(`plug-in ${name} takes no choice — it has no lookup`, 400);
      }
      if (typeof plugin.validateChoice === 'function') {
        try { plugin.validateChoice(choice); } catch (err) { throw new WebError(err.message, 400); }
      }
    }
    const params = {};
    if (scope !== plugins.JOB_SCOPES.SONG) { params.scope = scope; }
    if (choice) { params.choice = choice; }
    const { job, created } = jobsDb.createJob({
      plugin: name,
      userId: req.user ? req.user.id : null,
      key: plugins.jobKey(recommendation, scope),
      recommendation,
      params: Object.keys(params).length ? params : null,
    });
    if (created) { runner.kick(); }
    // The live job that already covers this recommendation may be another
    // account's. Its row is theirs (the caller could never poll it), so say
    // only that it is being fetched.
    if (!created && !isAdmin(req.user) && job.userId !== (req.user ? req.user.id : null)) {
      throw new WebError('someone else on this server is already getting this — try again in a moment', 409);
    }
    res.status(created ? 202 : 200).json({ job, created });
  });

  // What has the caller already done with this recommendation? Their newest
  // job per plug-in and scope — the song, its album, its artist — so a
  // client can draw each row in its real state when a recommendation is
  // opened again (the keys are the server's to compute). `key` is the song's,
  // as it always was; `keys` names every scope's.
  mstream.post('/api/v1/discovery/plugin-jobs/lookup', (req, res) => {
    const schema = Joi.object({ recommendation: plugins.recommendationSchema.required() });
    const { value: { recommendation } } = joiValidate(schema, req.body);
    const keys = plugins.jobKeysFor(recommendation);
    const jobs = jobsDb.latestForKeys({ userId: req.user ? req.user.id : null, keys: Object.values(keys) });
    res.json({ key: keys.song, keys, jobs });
  });

  mstream.post('/api/v1/discovery/plugin-jobs/clear', (req, res) => {
    res.json({ removed: jobsDb.clearFinished(req.user ? req.user.id : null) });
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
    let shown = jobs;
    if (everyone) {
      // The admin's all-accounts view names each job's owner. A job outlives
      // its account (the id goes NULL), so a missing name is simply null — and
      // so is the shared anonymous account of a server with no users, whose
      // internal name means nothing to an operator.
      const names = jobsDb.usernamesFor(jobs.map((j) => j.userId));
      const anonId = db.getAnonymousUserId();
      shown = shown.map((j) => ({ ...j, username: (j.userId !== anonId && names.get(j.userId)) || null }));
    }
    res.json({ jobs: shown, runner: { running: runner.runningCount(), active: runner.isRunning() } });
  });

  mstream.get('/api/v1/discovery/plugin-jobs/:id', (req, res) => {
    res.json({ job: ownJob(req, req.params.id) });
  });

  mstream.post('/api/v1/discovery/plugin-jobs/:id/cancel', (req, res) => {
    const job = ownJob(req, req.params.id);
    const outcome = jobsDb.requestCancel(job.id);
    if (outcome === null) {
      throw new WebError(`job ${job.id} is already ${job.state}`, 409);
    }
    res.json({ job: jobsDb.getJob(job.id), outcome });
  });
}
