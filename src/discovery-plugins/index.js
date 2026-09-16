// Built-in discovery plug-ins, registered once at import. Everything the
// server needs from the plug-in system comes through this module, so adding
// a plug-in is: write it under ./plugins, import it here, give it a config
// entry in src/state/config.js.

import { registerPlugin } from './registry.js';
import links from './plugins/links.js';
import deezer from './plugins/deezer.js';
import itunes from './plugins/itunes.js';
import federationPlay from './plugins/federation-play.js';

registerPlugin(links);
registerPlugin(deezer);
registerPlugin(itunes);
registerPlugin(federationPlay);

// Test-only runnable plug-in — exercises the job path end to end without a
// catalogue or a disk. Never registered unless the environment asks.
if (process.env.MSTREAM_TEST_DISCOVERY_NOOP_PLUGIN === '1') {
  const { default: noopAcquire } = await import('./plugins/noop-acquire.js');
  registerPlugin(noopAcquire);
}

export {
  CAPABILITIES, RESOLVING_CAPABILITIES, RUNNABLE_CAPABILITIES, SCOPES,
  getPlugin, isPluginEnabled, listPlugins, anyPluginEnabled, pluginNames, runnablePlugins,
} from './registry.js';
export {
  RECOMMENDATION_SOURCES, recommendationSchema, normalizeRecommendation, recommendationKey, searchPhrase,
} from './recommendation.js';
