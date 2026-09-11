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
 * these SAME wrapped conversation/message method references, so
 * sovereign-vs-Mongo dispatch happens here, ONCE, for all of them.
 * Every other `~/models` export (users, presets, roles, files, agent-event
 * actors, subagent threads, …) passes through `wrapModelMethods`
 * unchanged — this only touches the named conversation/message methods.
 */
const wrappedMethods = wrapModelMethods(methods);

module.exports = {
  ...methods,
  ...wrappedMethods,
  seedDatabase,
};
