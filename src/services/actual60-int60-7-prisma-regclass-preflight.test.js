"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REQUIRED_COLUMNS,
  prerequisiteState,
} = require("../../scripts/database/actual60-refreshsession-online-index-preflight");

test("INT60.7 Render/Prisma 5.22: prerequisite table probe casts regclass to text before deserialization", async () => {
  const calls = [];
  const db = {
    async $queryRawUnsafe(sql) {
      const query = String(sql);
      calls.push(query);
      if (calls.length === 1) {
        assert.match(query, /to_regclass\([\s\S]*?\)::text\s+AS\s+relation/i);
        return [{ relation: '"RefreshSession"' }];
      }
      if (calls.length === 2) {
        return REQUIRED_COLUMNS.map((column_name) => ({ column_name }));
      }
      throw new Error(`unexpected query #${calls.length}: ${query}`);
    },
  };

  const state = await prerequisiteState(db);
  assert.deepEqual(state, {
    ready: true,
    tableExists: true,
    populated: true,
    missingColumns: [],
  });
  assert.equal(calls.length, 2);
});
