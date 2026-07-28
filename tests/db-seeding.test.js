"use strict";

// Bug 2 behavioral tests against a real PostgreSQL server: the SQL captured
// from the real UI is executed against a minimal replica of the exchange
// schema. Reseeding one exchange must never touch another exchange's bot
// listings, while the explicit "Clear EDA NPC Listings" action stays global.
// 64-bit exchange ids are used throughout so precision loss would surface as
// missing or misplaced rows.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHarness, exchangeRow } = require("./helpers/harness");
const db = require("./helpers/db");

const DB_NAME = "eda_bot_test_seeding";
const FIXTURE = path.join(__dirname, "fixtures", "dune-schema.sql");

// 2^53 + 1 and BIGINT max: both unrepresentable as JS numbers.
const EX_A = "9007199254740993";
const EX_B = "9223372036854775807";
const AP_A = "101";
const AP_B = "102";

// Test seed plan at default settings (grades baked into the plan; no UI
// expansion): TestRifle q0+q3 (2+2) + TestSchematic 2 + TestOre 2 +
// TestAugment q1+q2 (2+2) + UnsafeThing 1 = 13 listings per seeded exchange.
// UnsafeThing is in the plan's unsafe list but is seeded once per exchange so
// the cleanup job has a bot-owned unsafe row to remove.
const LISTINGS_PER_SEED = 13;

const available = db.psqlAvailable();

function exchangeRows() {
  return [
    exchangeRow({ exchange_id: EX_A, access_point_count: "1" }),
    exchangeRow({ exchange_id: EX_B, access_point_count: "1" })
  ];
}

async function dbBackedHarness() {
  const harness = await createHarness();
  harness.onExecute = async ({ query }) => { db.execSql(DB_NAME, query); return { rows: [] }; };
  await harness.loadExchangesWithRows(exchangeRows());
  return harness;
}

function botOrderCount(exchangeId) {
  return Number(db.queryOne(DB_NAME, `
    SELECT COUNT(*) FROM dune.dune_exchange_orders o
    JOIN dune.actors a ON a.id = o.owner_id
    WHERE a.class = 'Revy' AND o.exchange_id = ${exchangeId}`));
}

test("seeding and cleanup against PostgreSQL", { skip: !available && "psql is not available" }, async (t) => {
  db.createTestDb(DB_NAME);
  db.loadFixture(DB_NAME, FIXTURE);
  db.execSql(DB_NAME, `
    INSERT INTO dune.dune_exchange_accesspoints (id, exchange_id) VALUES
      (${AP_A}, ${EX_A}),
      (${AP_B}, ${EX_B});`);
  t.after(() => db.dropTestDb(DB_NAME));

  const harness = await dbBackedHarness();

  await t.test("seeding preserves the exact 64-bit exchange id", async () => {
    harness.el("exchangeId").value = EX_A;
    const sql = await harness.clickAndCaptureSql("seedMarket");
    assert.ok(sql, `seed write did not run: ${harness.statusText()}`);

    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED);
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(DISTINCT exchange_id) FROM dune.dune_exchange_orders"), "1");
    assert.equal(db.queryOne(DB_NAME, "SELECT DISTINCT exchange_id::text FROM dune.dune_exchange_orders"), EX_A);
    // The corrupted double-precision neighbor must not appear anywhere.
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders WHERE exchange_id = 9007199254740992"), "0");
    assert.equal(db.queryOne(DB_NAME, `SELECT DISTINCT access_point_id::text FROM dune.dune_exchange_orders`), AP_A);
    // Backing items land in exchange A's inventory with matching sell orders.
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.items WHERE inventory_id = ${EX_A}`), String(LISTINGS_PER_SEED));
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_sell_orders"), String(LISTINGS_PER_SEED));
    // Absolute durability is on item stats; order wear stays normalized 1.0/1.0.
    assert.match(
      db.queryOne(DB_NAME, `SELECT stats::text FROM dune.items WHERE inventory_id = ${EX_A} AND template_id = 'TestAugment' AND quality_level = 1 LIMIT 1`),
      /"MaxDurability"\s*:\s*180/
    );
    assert.equal(
      db.queryOne(DB_NAME, `SELECT (stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability') FROM dune.items WHERE inventory_id = ${EX_A} AND template_id = 'TestAugment' AND quality_level = 1 LIMIT 1`),
      "180"
    );
    assert.equal(
      db.queryOne(DB_NAME, `SELECT durability_cur::text || '/' || durability_max::text FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_A} LIMIT 1`),
      "1/1"
    );
  });

  await t.test("seeding a second exchange leaves the first untouched", async () => {
    harness.el("exchangeId").value = EX_B;
    const sql = await harness.clickAndCaptureSql("seedMarket");
    assert.ok(sql, `seed write did not run: ${harness.statusText()}`);

    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED);
    assert.equal(botOrderCount(EX_B), LISTINGS_PER_SEED);
  });

  let exchangeAOrderIdsBeforeReseed;
  await t.test("reseeding with clear-existing only replaces the selected exchange", async () => {
    exchangeAOrderIdsBeforeReseed = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_A} ORDER BY id`).map((row) => row[0]);
    const exchangeBOrderIdsBefore = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_B} ORDER BY id`).map((row) => row[0]);

    harness.el("exchangeId").value = EX_A;
    assert.equal(harness.el("clearExisting").checked, true, "clear-existing is on by default");
    const sql = await harness.clickAndCaptureSql("seedMarket");
    assert.ok(sql, `reseed write did not run: ${harness.statusText()}`);

    // Exchange A was cleared and reseeded: same count, all-new order ids.
    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED);
    const exchangeAOrderIdsAfter = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_A} ORDER BY id`).map((row) => row[0]);
    for (const oldId of exchangeAOrderIdsBeforeReseed) {
      assert.ok(!exchangeAOrderIdsAfter.includes(oldId), `old exchange A order ${oldId} must be deleted`);
    }
    // The reported bug: exchange B's bot listings must survive byte-for-byte.
    const exchangeBOrderIdsAfter = db.queryRows(DB_NAME, `SELECT id FROM dune.dune_exchange_orders WHERE exchange_id = ${EX_B} ORDER BY id`).map((row) => row[0]);
    assert.deepEqual(exchangeBOrderIdsAfter, exchangeBOrderIdsBefore, "reseeding exchange A must not delete exchange B's orders");
    // Old exchange A backing items were deleted, exchange B's kept.
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.items WHERE inventory_id = ${EX_A}`), String(LISTINGS_PER_SEED));
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.items WHERE inventory_id = ${EX_B}`), String(LISTINGS_PER_SEED));
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_sell_orders"), String(2 * LISTINGS_PER_SEED));
  });

  await t.test("unattended reseed replaces bot listings even with clear-existing unchecked", async () => {
    // An unattended reseed that appends instead of replacing would stack a
    // whole extra market onto the exchange on every interval, so auto seed
    // always clears the bot's own listings for the selected exchange first.
    harness.el("exchangeId").value = EX_A;
    harness.setCheckbox("clearExisting", false);
    harness.setCheckbox("autoSeed", true);
    harness.advanceTime(361 * 60000);
    harness.autoTick();
    await harness.waitFor(() => harness.autoStatusText().includes("Auto seed: finished"), { label: "auto seed completion" });

    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED, "auto seed must replace, not duplicate, the bot market");
    assert.equal(botOrderCount(EX_B), LISTINGS_PER_SEED, "auto seed must not touch another exchange");
    assert.equal(db.queryOne(DB_NAME, `SELECT COUNT(*) FROM dune.items WHERE inventory_id = ${EX_A}`), String(LISTINGS_PER_SEED));
    harness.setCheckbox("autoSeed", false);
    harness.setCheckbox("clearExisting", true);
  });

  await t.test("auto cleanup drops unsafe bot listings and spares players", async () => {
    // The bundled unsafe list ('UnsafeThing') covers bot rows; a player listing
    // with the same template must survive. Reasserting player safety here
    // keeps the timer job pinned to the same scope as the manual button.
    db.execSql(DB_NAME, `
      INSERT INTO dune.actors (id, class, partition_id) VALUES (900002, 'BP_DuneCharacter', 1);
      INSERT INTO dune.items (id, inventory_id, stack_size, position_index, template_id) VALUES (800050, ${EX_A}, 1, 9998, 'UnsafeThing');
      INSERT INTO dune.dune_exchange_orders (id, exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, item_price, item_id)
      VALUES (700050, ${EX_A}, ${AP_A}, 900002, FALSE, 123456, 'UnsafeThing', 111, 800050);
      INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (700050, 1, 111);`);

    const botUnsafe = db.queryOne(DB_NAME, `
      SELECT COUNT(*) FROM dune.dune_exchange_orders o JOIN dune.actors a ON a.id = o.owner_id
      WHERE a.class = 'Revy' AND o.template_id = 'UnsafeThing'`);
    assert.ok(Number(botUnsafe) > 0, "fixture must start with unsafe bot listings");

    harness.el("exchangeId").value = EX_A;
    harness.setCheckbox("autoCleanup", true);
    harness.advanceTime(361 * 60000);
    harness.autoTick();
    await harness.waitFor(() => harness.autoStatusText().includes("Auto cleanup: finished"), { label: "auto cleanup completion" });

    assert.equal(
      db.queryOne(DB_NAME, `
        SELECT COUNT(*) FROM dune.dune_exchange_orders o JOIN dune.actors a ON a.id = o.owner_id
        WHERE a.class = 'Revy' AND o.template_id = 'UnsafeThing'`),
      "0",
      "unsafe bot listings must be dropped"
    );
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders WHERE id = 700050"), "1", "player unsafe listings must survive");
    // Safe listings = the full seed minus the one unsafe bot row it carried.
    assert.equal(botOrderCount(EX_A), LISTINGS_PER_SEED - 1, "cleanup must not touch safe bot listings");
    harness.setCheckbox("autoCleanup", false);
  });

  await t.test("global clear removes bot listings from every exchange but spares players", async () => {
    // A player listing that must survive both cleanups.
    db.execSql(DB_NAME, `
      INSERT INTO dune.actors (id, class, partition_id) VALUES (900001, 'BP_DuneCharacter', 1);
      INSERT INTO dune.items (id, inventory_id, stack_size, position_index, template_id) VALUES (800001, ${EX_A}, 10, 9999, 'TestOre');
      INSERT INTO dune.dune_exchange_orders (id, exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, item_price, item_id)
      VALUES (700001, ${EX_A}, ${AP_A}, 900001, FALSE, 123456, 'TestOre', 111, 800001);
      INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (700001, 10, 111);`);

    const sql = await harness.clickAndCaptureSql("clearNpc");
    assert.ok(sql, `clear write did not run: ${harness.statusText()}`);
    assert.match(harness.confirmMessages.at(-1), /ALL exchanges/);

    assert.equal(botOrderCount(EX_A), 0);
    assert.equal(botOrderCount(EX_B), 0);
    // Only the two player listings survive: the TestOre row inserted above and
    // the UnsafeThing row the unsafe-cleanup test deliberately spared.
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders"), "2");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_orders WHERE owner_id IN (900001, 900002)"), "2");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.dune_exchange_sell_orders"), "2");
    assert.equal(db.queryOne(DB_NAME, "SELECT COUNT(*) FROM dune.items"), "2");
  });
});
