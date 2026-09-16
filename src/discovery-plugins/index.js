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

export {
  CAPABILITIES, RESOLVING_CAPABILITIES, SCOPES, getPlugin, isPluginEnabled, listPlugins, anyPluginEnabled, pluginNames,
} from './registry.js';
export {
  RECOMMENDATION_SOURCES, recommendationSchema, normalizeRecommendation, recommendationKey, searchPhrase,
} from './recommendation.js';
