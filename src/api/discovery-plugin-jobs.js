// Discovery plug-in jobs — the acquire / hand-off half of the plug-in API.
//
//   POST /api/v1/discovery/plugins/:name/jobs    start a job for one recommendation
//   GET  /api/v1/discovery/plugin-jobs           the caller's jobs (admins: ?all=1)
//   GET  /api/v1/discovery/plugin-jobs/:id       one job
//   POST /api/v1/discovery/plugin-jobs/:id/cancel
//   POST /api/v1/discovery/plugin-jobs/lookup     the caller's newest job per plug-in for one recommendation
//   POST /api/v1/discovery/plugin-jobs/lookup/batch   the same for up to 100 recommendations, one query
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
// One account may hold discoveryJobs.maxQueuedPerUser jobs queued or
// running at once (429 past it), and the runner takes turns between
// accounts, so nobody's Get it waits behind somebody else's discography.
//
// The same (plug-in, recommendation) is never queued twice while a job for
// it is live: the second ask answers 200 with the existing job instead of
// 202 with a new one. When the live job is somebody else's the caller gets a
// 409 rather than a row they could not read again.
//
// An acquire job lands where the account's collection destination says
// (destination.js), and takes it along: the effective destination is pinned
// in the job's params when it is asked for, so a queued job never moves
// when the destination changes before it runs. A client may send the
// destination it showed; one that is no longer in force answers 409
// { error: 'destination_changed', destination } with the one that is, and
// starts nothing — files never land somewhere the client did not show.

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
    const acquires = plugin.capabilities.includes(plugins.CAPABILITIES.ACQUIRE);
    if (acquires) { checkUploadRight(req.user); }
    // One account's share of the queue (discoveryJobs.maxQueuedPerUser):
    // past it, come back when some have finished. The runner takes turns
    // between accounts besides, so a long queue never holds others' jobs.
    const cap = Number((config.program && config.program.discoveryJobs && config.program.discoveryJobs.maxQueuedPerUser) || 20);
    const live = jobsDb.countLiveForUser(req.user ? req.user.id : null);
    if (live >= cap) {
      throw new WebError(`you have ${live} jobs queued or running — wait for some to finish (the limit is ${cap})`, 429);
    }

    const schema = Joi.object({
      recommendation: plugins.recommendationSchema.required(),
      // What the job acts on (plugins.JOB_SCOPES): the song unless the
      // plug-in declares wider scopes and the caller asks for one.
      scope: Joi.string().valid(...Object.values(plugins.JOB_SCOPES)).optional(),
      // An upload the caller picked from the plug-in's lookup: the job
      // fetches that one instead of searching. Only a plug-in with a
      // lookup takes one, and it checks the link itself (validateChoice).
      choice: Joi.object({ url: Joi.string().uri({ scheme: ['http', 'https'] }).max(2048).required() }).optional(),
      // Where a folder job lands (the folder scope only): a library and a
      // folder inside it the caller chose (`path` is where the pressed
      // folder's own files go, its subfolders beneath), or `tags: true` to
      // file the songs by the collection layout like any other copy.
      // Absent = the folder as it is on the peer, under the destination's
      // base folder (destination.js validateLanding).
      landing: Joi.object({
        vpath: Joi.string().min(1).max(200).optional(),
        path: Joi.string().allow('').max(500).optional(),
        tags: Joi.boolean().optional(),
      }).optional(),
      // The collection destination the client showed (the destination
      // route's `destination`, forwarded as it came — its `source` is not
      // compared; null when it showed none). An acquire job is refused with
      // 409 destination_changed when it is no longer the one in force.
      // Absent = no check. A plug-in that lands nothing ignores it.
      destination: destinations.destinationSchema.keys({ source: Joi.string().max(20).optional() }).allow(null).optional(),
    });
    const { value: { recommendation, scope: askedScope, choice, landing: askedLanding, destination: shown } } = joiValidate(schema, req.body);
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
    let landing = null;
    if (askedLanding) {
      if (scope !== plugins.JOB_SCOPES.FOLDER) { throw new WebError('a landing folder applies to a folder job only', 400); }
      landing = destinations.validateLanding(askedLanding, req.user);
    }
    const key = plugins.jobKey(recommendation, scope);
    const params = {};
    if (scope !== plugins.JOB_SCOPES.SONG) { params.scope = scope; }
    if (choice) { params.choice = choice; }
    if (landing) { params.landing = landing; }
    if (acquires) {
      // Where the job lands, settled now and kept with it (the plug-in
      // reads it back through destination.js destinationForJob). A client
      // that showed another place is told the one in force instead — unless
      // a live job already covers this recommendation: that one answers as
      // before, with its own pinned destination in its params. A null pin
      // (nowhere to put a file) is kept too: the job fails rather than land
      // in a library the account is given while it waits.
      const destination = destinations.getDestination(req.user);
      if (shown !== undefined && !destinations.sameDestination(shown, destination) && !jobsDb.liveJob(name, key)) {
        res.status(409).json({
          error: 'destination_changed',
          message: 'your collection destination has changed — check where this will land and ask again',
          destination,
        });
        return;
      }
      params.destination = destination;
    }
    const { job, created } = jobsDb.createJob({
      plugin: name,
      userId: req.user ? req.user.id : null,
      key,
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

  // The same for a page of recommendations at once: the Discover page draws
  // dozens of rows, and one SELECT beats a round trip per row. Each result
  // is exactly the single form's answer for its recommendation, in input
  // order — one latestForKeys over every row's keys, split back by key.
  // The split is exact because what latestForKeys keeps for a key (the
  // newest job per plug-in under it) does not depend on the other keys
  // asked alongside, so a key two rows share (two songs of one album)
  // answers both with the same job, and filtering the newest-first list
  // keeps the single form's order. A path of its own rather than a new
  // body key on the single form: that body is strict, so a client sending
  // the new key to a server that predates it would get a 400 (clients ask
  // here only when ping advertises discoveryTaste). The cap bounds the IN
  // list: 100 rows × 5 scopes + the user id stays under SQLite's oldest
  // 999-variable limit.
  mstream.post('/api/v1/discovery/plugin-jobs/lookup/batch', (req, res) => {
    const schema = Joi.object({
      recommendations: Joi.array().items(plugins.recommendationSchema).min(1).max(100).required(),
    });
    const { value: { recommendations } } = joiValidate(schema, req.body);
    const keysPer = recommendations.map((recommendation) => plugins.jobKeysFor(recommendation));
    const allKeys = [...new Set(keysPer.flatMap((keys) => Object.values(keys)))];
    const jobs = jobsDb.latestForKeys({ userId: req.user ? req.user.id : null, keys: allKeys });
    const results = keysPer.map((keys) => {
      const own = new Set(Object.values(keys));
      return { key: keys.song, keys, jobs: jobs.filter((job) => own.has(job.key)) };
    });
    res.json({ results });
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
