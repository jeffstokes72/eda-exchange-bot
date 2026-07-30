"use strict";

// Bug 2 regression tests plus buyback SQL generation checks, asserted on the
// SQL text the addon hands to the bridge. Runtime behavior against a real
// PostgreSQL server is covered by the db-*.test.js files.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

const EXCHANGE_ID = "4242";

async function harnessWithExchange() {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: EXCHANGE_ID })]);
  return harness;
}

test("seeding cleanup is scoped to owner AND selected exchange", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(sql, `seed write did not run: ${harness.statusText()}`);

  assert.match(sql, /DELETE FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id;/);
  assert.match(sql, /DELETE FROM dune\.dune_exchange_sell_orders WHERE order_id IN \(SELECT id FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id\);/);
  assert.match(sql, /WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id AND item_id IS NOT NULL;/);
  // The unscoped delete from the reported bug must be gone.
  assert.ok(!/WHERE owner_id = v_owner_id\s*;/.test(sql), "cleanup must not delete across all exchanges");
  // The cleanup block resolves the same selected exchange id before deleting.
  assert.ok(sql.includes(`v_exchange_id := ${EXCHANGE_ID};`), "cleanup must resolve the selected exchange before deleting");
});

test("unchecking clear-existing removes the cleanup block entirely", async () => {
  const harness = await harnessWithExchange();
  harness.setCheckbox("clearExisting", false);
  const sql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(sql, `seed write did not run: ${harness.statusText()}`);
  assert.ok(!sql.includes("DELETE FROM dune.dune_exchange"), "no sell/order deletes expected when clear-existing is off");
  assert.ok(!sql.includes("DELETE FROM dune.items"), "no backing item deletes expected when clear-existing is off");
});

test("global clear confirmation states it affects all exchanges", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("clearNpc");
  assert.ok(sql, `clear write did not run: ${harness.statusText()}`);
  const confirmMessage = harness.confirmMessages.at(-1);
  assert.match(confirmMessage, /ALL exchanges/, `confirmation must warn about all exchanges: ${confirmMessage}`);
  // The global action intentionally stays unscoped: no exchange filter.
  assert.ok(!sql.includes("exchange_id ="), "global clear intentionally has no exchange filter");
});

test("declining the global clear confirmation runs nothing", async () => {
  const harness = await harnessWithExchange();
  harness.confirmResponse = false;
  harness.el("clearNpc").click();
  await harness.flush();
  assert.equal(harness.executedSql().length, 0);
});

test("buyback SQL: plan prices, per-grade caps, and threshold rounding", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql, `buyback write did not run: ${harness.statusText()}`);

  // Threshold 60%: ceil(seeded_grade_price * 60 / 100) per (template, grade).
  // Caps come from each seeded row directly — not q0 × grade_mult in SQL —
  // so stepped rounding on higher grades cannot miss true 60% of market.
  assert.ok(sql.includes("('TestRifle',0,3000)"), "TestRifle q0: 5000 * 60% = 3000");
  assert.ok(sql.includes("('TestRifle',3,4800)"), "TestRifle q3: 8000 * 60% = 4800 (not FLOOR(3000*1.5)=4500)");
  assert.ok(sql.includes("('TestSchematic',1,6000)"), "TestSchematic q1: 10000 * 60% = 6000");
  assert.ok(sql.includes("('TestOre',0,300)"), "TestOre q0: 500 * 60% = 300");
  assert.ok(sql.includes("('TestAugment',1,6000)"), "TestAugment q1: 10000 * 60% = 6000");
  assert.ok(sql.includes("('TestAugment',2,7500)"), "TestAugment q2: 12500 * 60% = 7500");
  assert.ok(!sql.includes("('TestRifle',3000)"), "legacy template-only plan tuples must be gone");
  assert.ok(!sql.includes("FLOOR(p.max_unit_price *"), "must not re-apply grade multipliers in SQL");
});

test("buyback SQL: payment records are per-unit, never-expiring, seller-owned", async () => {
  const harness = await harnessWithExchange();
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql, `buyback write did not run: ${harness.statusText()}`);

  // Payment entry: owned by the seller, per-unit item_price (the game
  // multiplies by stack size), sentinel expiry, not an NPC order.
  assert.ok(sql.includes(
    "VALUES (rec.exchange_id, rec.access_point_id, rec.seller_actor_id, rec.template_id, 999999999, 1.0, 1.0, rec.item_price, 0, 0, FALSE)"
  ), "payment insert must be per-unit with the never-expires sentinel");
  assert.ok(!sql.includes("rec.item_price * rec.actual_stack) RETURNING id INTO v_log_order_id"), "payment must not pre-multiply by stack size");
  // Fulfilled-order audit row references the bought order.
  assert.match(sql, /INSERT INTO dune\.dune_exchange_fulfilled_orders \(order_id, source_order_id, completion_type, stack_size, original_order_id\)/);
  // Sweep only touches the selected exchange and player orders.
  assert.ok(sql.includes(`o.exchange_id = ${EXCHANGE_ID} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id`));
  // Reject non-positive prices/stacks; cap is already grade-specific so the
  // predicate compares item_price to max_unit_price directly. Stack quantity
  // takes GREATEST(item, sell_order) so a resource listing is bought in full.
  assert.match(sql, /o\.item_price > 0 AND GREATEST\(COALESCE\(i\.stack_size, 0\), COALESCE\(s\.initial_stack_size, 0\)\) > 0 AND o\.item_price <= p\.max_unit_price/);
  assert.match(sql, /GREATEST\(COALESCE\(i\.stack_size, 0\), COALESCE\(s\.initial_stack_size, 0\)\) AS actual_stack/);
  // Grade comes from whichever of the order/item rows carries it: the order
  // column is NOT NULL DEFAULT 0, so COALESCE alone would never see an item
  // rank. The plan lookup then prefers the listing's own grade and otherwise
  // falls back to the nearest seeded grade below it.
  assert.match(sql, /LEAST\(GREATEST\(COALESCE\(o\.quality_level, 0\), COALESCE\(i\.quality_level, 0\), 0\), 5\)/);
  assert.ok(!sql.includes("COALESCE(o.quality_level, i.quality_level, 0)"), "order grade must not COALESCE past a NOT NULL column");
  assert.match(sql, /LEFT JOIN LATERAL \(\s+SELECT pp\.template_id, pp\.quality_level, pp\.max_unit_price\s+FROM market_buy_plan pp\s+WHERE pp\.template_id = o\.template_id/);
  assert.match(sql, /ORDER BY \(pp\.quality_level <= LEAST\(GREATEST\(COALESCE\(o\.quality_level, 0\), COALESCE\(i\.quality_level, 0\), 0\), 5\)\) DESC/);
  // Max buys limit applies, and selected orders are locked so concurrent
  // sweeps (other tabs/admins) skip them instead of buying them twice.
  assert.match(sql, /LIMIT 500 FOR UPDATE OF o, s SKIP LOCKED LOOP/);
  // Per-listing outcome log with stable error codes.
  assert.match(sql, /CREATE TEMP TABLE market_buy_log/);
  assert.match(sql, /WHEN o\.item_price > p\.max_unit_price THEN 1/);
  assert.match(sql, /WHEN p\.template_id IS NULL THEN 2/);
  assert.match(sql, /result_label = 'success'/);
  assert.match(sql, /result_label = CASE WHEN r\.rn > 500 THEN 'max buys limit' ELSE 'skipped locked' END/);
  assert.match(sql, /ROW_NUMBER\(\) OVER \(ORDER BY item_price ASC, order_id ASC\)/);
  assert.match(sql, /buyback_report/);
});

test("buyback SQL: changing threshold and max buys is reflected", async () => {
  const harness = await harnessWithExchange();
  harness.setValue("buybackPercent", 50);
  harness.setValue("maxBuys", 25);
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql.includes("('TestOre',0,250)"), "TestOre q0: 500 * 50% = 250");
  assert.ok(sql.includes("('TestRifle',3,4000)"), "TestRifle q3: 8000 * 50% = 4000");
  assert.match(sql, /LIMIT 25 FOR UPDATE OF o, s SKIP LOCKED LOOP/);
  assert.match(sql, /VALUES \(v_purchased, v_units, v_solari, 50, 25\)/);
  assert.match(sql, /CASE WHEN r\.rn > 25 THEN 5 ELSE 6 END/);
});

test("buyback classify SQL assigns price-too-high and no-reference codes", async () => {
  const harness = await harnessWithExchange();
  const queries = [];
  harness.onQuery = async ({ query }) => {
    queries.push(query);
    if (String(query).includes("known_exchanges")) return { rows: [exchangeRow({ exchange_id: EXCHANGE_ID })] };
    return {
      rows: [
        { order_id: "1", template_id: "TestOre", quality_level: "0", item_price: "250", stack_size: "100", max_unit_price: "300", result_code: "0", result_label: "eligible", detail: "ask 250 <= cap 300" },
        { order_id: "2", template_id: "TestOre", quality_level: "0", item_price: "400", stack_size: "100", max_unit_price: "300", result_code: "1", result_label: "price too high", detail: "ask 400 > cap 300" },
        { order_id: "3", template_id: "UnknownThing", quality_level: "0", item_price: "10", stack_size: "1", max_unit_price: "0", result_code: "2", result_label: "no reference price", detail: "template not in seed plan" }
      ]
    };
  };
  harness.el("refreshBuybackLog").click();
  await harness.waitFor(() => harness.el("buybackLog").textContent.includes("0x1"), { label: "buyback log dry-run" });
  const classifySql = queries.find((query) => query.includes("result_code") && query.includes("price too high"));
  assert.ok(classifySql, "dry-run must run the classify query");
  assert.match(classifySql, /WHEN o\.item_price > p\.max_unit_price THEN 1/);
  assert.match(classifySql, /WHEN p\.template_id IS NULL THEN 2/);
  assert.match(harness.el("buybackLog").textContent, /price too high/);
  assert.match(harness.el("buybackLog").textContent, /no reference price/);
  assert.match(harness.el("buybackLog").textContent, /0x0/);
});
