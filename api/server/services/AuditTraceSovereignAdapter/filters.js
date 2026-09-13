/**
 * Pure Mongo-filter SHAPE helpers for `AuditTraceSovereignAdapter`
 * (MongoDB-elimination EPIC — the foundational adapter base, WU-B of
 * `2026-09-13-SPEC-sovereign-store-and-adapter-abstractions`). No I/O, no
 * token — kept separate from `index.js` so the classification the whole
 * read/write discipline hangs on is independently, exhaustively testable.
 *
 * **Why SHAPE, never "has a `user` key".** Both files-shim REJECTs
 * (`lesson-sovereign-adapter-read-discipline-20260913`) were the same
 * bug with opposite symptoms: a bespoke per-domain classifier guessing
 * "is this read own-scoped?" from the presence of an owner key. v1 threw
 * on every shape it hadn't whitelisted; v2 sent every no-`user`-key read
 * to Mongo — including the OWNER's own `{file_id}` reads (route-level ACL
 * had already established ownership, so the filter carried no `user`),
 * which 404'd on a sovereign-only row. The only shape question this
 * module answers is "does the filter ADDRESS specific row(s) by id?" —
 * if yes, the base resolves those ids sovereign-first under the caller's
 * own RLS scope, whatever else the filter carries.
 *
 * **The undefined-key short-circuit (reviewer F6 — a SECURITY finding).**
 * Mongoose STRIPS `undefined`-valued keys from a filter before querying,
 * so `File.find({_id: undefined})` is `File.find({})` — the WHOLE
 * collection, every user's rows. A route that re-fetched by
 * `{_id: file._id}` where `file` came from a sovereign record (no Mongo
 * `_id`) returned a STRANGER's document text under the caller's own
 * filename. `classifyFilter` therefore reports `unsafe` for ANY filter
 * that carries a present-but-`undefined` value, or that is empty, BEFORE
 * any id/owner classification — and the base maps `unsafe` to an empty
 * result, never a Mongo call. This is proven at the base level
 * (`index.spec.js`) with a side-effect assertion: the raw Mongo function
 * is NEVER invoked for such a filter.
 */

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {boolean} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * `true` iff `filter` is a plain object with at least one key and NO
 * key whose value is `undefined` (the shape Mongoose would silently
 * widen). `null` values are NOT flagged — Mongo matches `{k: null}`
 * against null-or-missing fields, a narrowing, never a widening.
 *
 * @param {unknown} filter
 * @returns {boolean}
 */
function isMongoSafeFilter(filter) {
  if (!isPlainObject(filter)) {
    return false;
  }
  const keys = Object.keys(filter);
  if (keys.length === 0) {
    return false;
  }
  return keys.every((key) => filter[key] !== undefined);
}

/**
 * `true` iff every plain-object argument carries no `undefined`-valued
 * key. Used by the base's `deferToMongo` guard for deferred methods whose
 * arguments are opaque to the base (an options bag, a compare-and-swap
 * `extraFilter`, …): an empty object is fine here (an empty OPTIONS bag
 * is not a filter), only a strippable key is unsafe.
 *
 * @param {unknown[]} args
 * @returns {boolean}
 */
function areMongoSafeArgs(args) {
  return args.every(
    (arg) => !isPlainObject(arg) || Object.keys(arg).every((key) => arg[key] !== undefined),
  );
}

/**
 * Normalizes one filter value into an explicit id list: a non-empty
 * string → `[value]`; `{$in: [...]}` → its non-empty-string members
 * (deduped, order preserved); anything else → `null` (not id-shaped).
 *
 * @param {unknown} value
 * @returns {string[]|null}
 */
function idListFromValue(value) {
  if (isNonEmptyString(value)) {
    return [value];
  }
  if (isPlainObject(value) && Array.isArray(value.$in)) {
    return [...new Set(value.$in.filter(isNonEmptyString))];
  }
  return null;
}

/**
 * Classifies a Mongo-style filter by SHAPE for the base's read/write
 * discipline. Exactly one of:
 *
 *   - `{kind: 'unsafe'}` — not a plain object, empty, or carrying a
 *     present-but-`undefined` value (reviewer F6). ALSO reported when the
 *     id key is present but not id-shaped (`{file_id: null}`,
 *     `{file_id: {$in: undefined}}`, `{file_id: 42}`, `{file_id: {$in: []}}`)
 *     — a filter that NAMES the id key but addresses nothing must never
 *     be forwarded as if it addressed everything.
 *   - `{kind: 'ids', key, ids}` — the id field (or one of its declared
 *     aliases, e.g. files' `_id`) names one id (string) or a `{$in}` set.
 *     `key` is the filter key that carried them, so the base can narrow
 *     the SAME key for a Mongo fall-through.
 *   - `{kind: 'own-list'}` — no id key, but the owner field is a non-empty
 *     string: the "everything I own" shape, served from the sovereign
 *     LIST endpoint. NOTE this is NOT owner-key scoping — RLS scopes by
 *     the token regardless; it only selects the list endpoint as the
 *     right tool for a whole-collection own read.
 *   - `{kind: 'residual'}` — a safe filter naming neither id nor owner
 *     (e.g. a TTL sweep); the base has no sovereign query surface for it
 *     and defers to Mongo UNCHANGED (disclosed per domain).
 *
 * @param {unknown} filter
 * @param {{idField: string, idAliases?: string[], ownerField: string}} shape
 * @returns {{kind: 'unsafe'}|{kind: 'ids', key: string, ids: string[]}|{kind: 'own-list'}|{kind: 'residual'}}
 */
function classifyFilter(filter, { idField, idAliases = [], ownerField }) {
  if (!isMongoSafeFilter(filter)) {
    return { kind: 'unsafe' };
  }
  for (const key of [idField, ...idAliases]) {
    if (!Object.prototype.hasOwnProperty.call(filter, key)) {
      continue;
    }
    const value = filter[key];
    const ids = idListFromValue(value);
    if (ids && ids.length > 0) {
      return { kind: 'ids', key, ids };
    }
    // The id key is PRESENT but addresses nothing we can resolve. An
    // ObjectId-typed `_id` (a real legacy Mongo id, an object with a
    // 24-hex `toHexString`) is the ONE legitimately-Mongo-native value:
    // it is defined, it addresses exactly one legacy row, so it stays
    // `residual` (deferred UNCHANGED). Everything else is `unsafe`.
    if (isPlainObject(value) && typeof value.toHexString === 'function') {
      return { kind: 'residual' };
    }
    return { kind: 'unsafe' };
  }
  if (isNonEmptyString(filter[ownerField])) {
    return { kind: 'own-list' };
  }
  return { kind: 'residual' };
}

/**
 * Builds the NARROWED Mongo filter for the ids the sovereign store did
 * not return: the SAME filter, with `key` swapped to `{$in: missingIds}`
 * and every other key preserved — so an already-served sovereign row is
 * never re-fetched from Mongo. Safe by construction: the input was
 * already classified `ids` (every key defined) and `missingIds` is
 * non-empty.
 *
 * @param {Record<string, unknown>} filter
 * @param {string} key
 * @param {string[]} missingIds
 * @returns {Record<string, unknown>}
 */
function narrowFilter(filter, key, missingIds) {
  return { ...filter, [key]: { $in: missingIds } };
}

/**
 * Applies the NON-id keys of a filter to an already-mapped sovereign
 * record, CLIENT-SIDE, after the RLS-scoped fetch. Recognizes exactly the
 * operators observed at live call sites across the migrated domains:
 * plain equality (primitives), `{$in: [...]}`, `{$exists: bool}`,
 * `{$ne: v}`. The id key and its aliases are skipped (already applied by
 * id resolution). The OWNER key is applied as plain equality against the
 * record's stamped owner — a faithful predicate, NOT a scoping decision
 * (a filter naming a different owner than the caller correctly matches
 * nothing the caller's own store returned).
 *
 * An unrecognized key shape (a dotted path, an unknown operator) is
 * IGNORED — never used to exclude — a disclosed functional imprecision
 * (a caller may see a slightly broader result than Mongo's stricter
 * filter), never a security relaxation: isolation is enforced by RLS on
 * the server regardless of what this post-filter does.
 *
 * @param {Record<string, unknown>} record - an already-mapped row.
 * @param {Record<string, unknown>} filter
 * @param {{idField: string, idAliases?: string[]}} shape
 * @returns {boolean}
 */
function matchesExtraConstraints(record, filter, { idField, idAliases = [] }) {
  const skip = new Set([idField, ...idAliases]);
  for (const [key, value] of Object.entries(filter)) {
    if (skip.has(key) || key.includes('.')) {
      continue;
    }
    const actual = record[key];
    if (isPlainObject(value)) {
      if (Array.isArray(value.$in) && !value.$in.includes(actual)) {
        return false;
      }
      if ('$exists' in value) {
        const has = actual !== undefined && actual !== null;
        if (has !== Boolean(value.$exists)) {
          return false;
        }
      }
      if ('$ne' in value && actual === value.$ne) {
        return false;
      }
      continue;
    }
    if (Array.isArray(value)) {
      continue;
    }
    if (value === null) {
      if (actual !== null && actual !== undefined) {
        return false;
      }
      continue;
    }
    if (actual !== value && String(actual) !== String(value)) {
      return false;
    }
  }
  return true;
}

module.exports = {
  isPlainObject,
  isNonEmptyString,
  isMongoSafeFilter,
  areMongoSafeArgs,
  idListFromValue,
  classifyFilter,
  narrowFilter,
  matchesExtraConstraints,
};
