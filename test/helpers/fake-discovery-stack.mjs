/**
 * A stand-in for state/discovery-p2p-stack.js: a discovery network that
 * starts and stops at once, no sidecar. Map the module's URL here with
 * module.registerHooks, for a test that drives the discovery switch for
 * what it does next (iroh-bridge-check.test.mjs: federation's start).
 */

export function getRecoveryState() { return null; }
export function armBootRetry() {}
export function startDiscoveryP2pStack() { return Promise.resolve(); }
export function stopDiscoveryP2pStack() { return Promise.resolve(); }
