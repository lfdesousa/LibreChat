const mongoose = require('mongoose');
const { createMethods } = require('@librechat/data-schemas');
const { matchModelName, findMatchingPattern, isDeploymentSkillId } = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');
const { wrapModelMethods } = require('~/server/services/AuditTraceConversations');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  isExternalSkillId: isDeploymentSkillId,
  getCache: getLogStores,
});

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
};

/**
 * MongoDB-elimination WU-2b — THE CHOKEPOINT (see
 * `server/services/AuditTraceConversations/index.js`'s module docstring
 * for the full rationale). Every caller of `require('~/models')` — routes,
 * controllers, `utils/import/fork.js`'s `const db = require('~/models')`,
 * `services/Schedules/index.js`'s injected `methods` param — receives
 * these SAME wrapped method references, so sovereign-vs-Mongo dispatch
 * happens here, ONCE, for all of them. Extended by WU-presets (2026-09-11,
 * the first reuse of this pattern) to also cover the preset methods
 * (`getPreset`/`getPresets`/`savePreset`/`deletePresets` —
 * `server/services/AuditTracePresets/index.js`), then by WU-prompts the
 * SAME day (the second reuse) to also cover the prompt-persistence
 * methods (`createPromptGroup`/`savePrompt`/`getPromptGroup`/`getPrompt`/
 * `getPrompts`/`updatePromptGroup`/`makePromptProduction`/
 * `deletePromptGroup`/`deleteUserPrompts`/`incrementPromptGroupUsage` —
 * `server/services/AuditTracePrompts/index.js`; the prompt ACL/sharing
 * methods and single-version delete deliberately stay unwired, see that
 * module's docstring), both merged into the SAME `wrapModelMethods()`
 * call below — still exactly one call site, one `AsyncLocalStorage`.
 * Every other `~/models` export (users, roles, files, agent-event
 * actors, subagent threads, …) passes through `wrapModelMethods`
 * unchanged — this only touches the named conversation/message/preset/
 * prompt methods.
 */
const wrappedMethods = wrapModelMethods(methods);

module.exports = {
  ...methods,
  ...wrappedMethods,
  seedDatabase,
};
