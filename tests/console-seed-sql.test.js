"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

test("console seed SQL omits outer BEGIN/COMMIT so db.transaction owns the txn", async () => {
  const modulePath = path.join(__dirname, "..", "console-patches", "addonSeedJob.js");
  const mod = await import(pathToFileURL(modulePath).href);
  const sql = mod.buildMarketSeedSql(
    {
      sourceMultiplier: 5,
      rows: [{
        templateId: "TestOre",
        stackSize: 100,
        price: 500,
        categoryMask: 1,
        categoryDepth: 1,
        qualityLevel: 0,
        kind: "resource",
        listings: 2,
        itemStats: "{}"
      }]
    },
    { exchangeId: "77", priceMultiplier: 5 }
  );

  assert.match(sql.trimStart(), /^CREATE TEMP TABLE market_seed_plan/);
  assert.ok(!/^\s*BEGIN;/m.test(sql), "must not open a nested SQL transaction");
  assert.ok(!/\nCOMMIT;\s*$/.test(sql), "must not COMMIT inside db.transaction");
  assert.match(sql, /DELETE FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id/);
});

test("console seed SQL regression: source still documents the transaction ownership", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "console-patches", "addonSeedJob.js"), "utf8");
  assert.match(src, /No outer BEGIN\/COMMIT/);
  assert.ok(!/return `BEGIN;/.test(src));
});
