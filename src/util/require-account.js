import WebError from './web-error.js';

// The account gate for routes that answer from one user's own state (a play
// history, what this user may see of the shelf): a federation key or a
// guest token builds a user with no id, or a federation-flagged one, and
// neither has such state here. The public-mode sentinel has an id and
// passes. The stats routes' rule (api/stats.js), shared by the Discover
// page's taste route and the p2p peers route.
export function requireAccount(req) {
  if (!req.user?.id || req.user.federation) { throw new WebError('Forbidden', 403); }
}
