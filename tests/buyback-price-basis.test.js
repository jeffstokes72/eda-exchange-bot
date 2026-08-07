"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

const EXCHANGE_ID = "4242";

async function harnessWithExchange() {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: EXCHANGE_ID })]);
  return harness;
}

test("buyback price basis defaults to seeded NPC caps", async () => {
  const harness = await harnessWithExchange();
  assert.equal(harness.el("buybackPriceBasis").value, "seeded");
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql.includes("INSERT INTO market_buy_plan (template_id, quality_level, max_unit_price) VALUES"), "seeded mode inserts VALUES caps");
  assert.ok(sql.includes("('TestOre',0,300)"), "seeded 60% of TestOre 500");
  assert.ok(!sql.includes("AVG(o.item_price)"), "seeded mode does not average live market");
  assert.ok(!sql.includes("MIN(o.item_price)"), "seeded mode does not take live market lowest");
});

test("buyback price basis average builds live AVG caps with seeded fallback", async () => {
  const harness = await harnessWithExchange();
  harness.setValue("buybackPriceBasis", "average");
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql.includes("AVG(o.item_price)"), "average mode aggregates live asks");
  assert.ok(sql.includes("live_buy_caps"), "average mode materializes live caps");
  assert.ok(sql.includes("seed_buy_caps"), "average mode keeps seeded fallback");
  assert.ok(sql.includes("FLOOR((basis_price * 60 + 99) / 100)"), "percent applies after the live average");
  assert.ok(!sql.includes("MIN(o.item_price)"), "average mode does not use MIN");
});

test("buyback price basis lowest builds live MIN caps with seeded fallback", async () => {
  const harness = await harnessWithExchange();
  harness.setValue("buybackPriceBasis", "lowest");
  harness.setValue("buybackPercent", 100);
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql.includes("MIN(o.item_price)"), "lowest mode aggregates live asks");
  assert.ok(sql.includes("FLOOR((basis_price * 100 + 99) / 100)"), "percent applies after the live lowest");
  assert.ok(!sql.includes("AVG(o.item_price)"), "lowest mode does not use AVG");
});

test("eligibility probe follows the selected live price basis", async () => {
  const harness = await harnessWithExchange();
  harness.setValue("buybackPriceBasis", "average");
  harness.setCheckbox("autoBuyback", true);
  let probeSql = null;
  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (text.includes("eligible_orders")) probeSql = text;
    return { rows: [{ eligible_orders: "0" }] };
  };
  harness.advanceTime(30 * 60000);
  harness.autoTick();
  await harness.waitFor(() => probeSql !== null, { label: "auto buyback eligibility probe" });
  assert.ok(probeSql.includes("AVG(o.item_price)"), "probe must use live average basis");
  assert.ok(probeSql.includes("live_buy_caps"), "probe CTE must include live caps");
});

test("buyback price basis is persisted in local settings", async () => {
  const harness = await harnessWithExchange();
  harness.setValue("buybackPriceBasis", "lowest");
  harness.el("buybackPriceBasis").dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  await harness.flush();
  const saved = JSON.parse(harness.window.localStorage.getItem("eda-exchange-bot.settings"));
  assert.equal(saved.buybackPriceBasis, "lowest");
});
