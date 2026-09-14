// Built-in discovery plug-ins, registered once at import. Everything the
// server needs from the plug-in system comes through this module, so adding
// a plug-in is: write it under ./plugins, import it here, give it a config
// entry in src/state/config.js.

import { registerPlugin } from './registry.js';
import links from './plugins/links.js';

registerPlugin(links);

export {
  CAPABILITIES, SCOPES, getPlugin, isPluginEnabled, listPlugins, anyPluginEnabled, pluginNames,
} from './registry.js';
export {
  RECOMMENDATION_SOURCES, recommendationSchema, normalizeRecommendation, recommendationKey, searchPhrase,
} from './recommendation.js';
