"use strict";
const object = x => x && typeof x === "object" && !Array.isArray(x) ? x : {};
const SETTLED_CODES = Object.freeze(['unfollowed', 'already_unfollowed', 'unfollowed_recovered']);
function isCleanup(d) { return d?.moduleKey === 'sfs' && d.actionType === 'SFS_UNFOLLOW_TARGET'; }
function isSettledCleanup(d) {
  return isCleanup(d) && d.status === 'COMPLETED' && SETTLED_CODES.includes(object(d.result).code)
    && Boolean(d.finishedAt) && (object(d.result).code === 'already_unfollowed' || Boolean(d.writeCommitAt));
}
const SETTLED_SQL = `"status"='COMPLETED' AND "finishedAt" IS NOT NULL AND COALESCE("result"->>'code','') IN ('unfollowed','already_unfollowed','unfollowed_recovered') AND ("result"->>'code'='already_unfollowed' OR "writeCommitAt" IS NOT NULL)`;
const UNSETTLED_SQL = `"moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET' AND NOT (${SETTLED_SQL})`;
module.exports = { SETTLED_CODES, isCleanup, isSettledCleanup, SETTLED_SQL, UNSETTLED_SQL };
