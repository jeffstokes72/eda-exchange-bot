"use strict";

// Bug 1 regression tests: PostgreSQL BIGINT exchange ids must survive the UI
// exactly. 9007199254740993 (2^53 + 1) is not representable as a JS number:
// Number("9007199254740993") === 9007199254740992, so any Number() conversion
// on the id would target the wrong exchange.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

const BIG_ID = "9007199254740993";
const CORRUPTED_BIG_ID = "9007199254740992";
const BIGINT_MAX = "9223372036854775807";
const ABOVE_BIGINT_MAX = "9223372036854775808";

test("sanity: the test id actually loses precision through Number()", () => {
  assert.equal(String(Number(BIG_ID)), CORRUPTED_BIG_ID);
});

test("exchange dropdown preserves 64-bit exchange ids exactly", async () => {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([
    exchangeRow({ exchange_id: BIG_ID, access_point_count: "2" }),
    exchangeRow({ exchange_id: BIGINT_MAX, access_point_count: "1" })
  ]);

  const values = harness.exchangeOptionValues();
  assert.ok(values.includes(BIG_ID), `expected exact option ${BIG_ID}, got ${values}`);
  assert.ok(values.includes(BIGINT_MAX), `expected exact option ${BIGINT_MAX}, got ${values}`);
  assert.ok(!values.includes(CORRUPTED_BIG_ID), "precision-corrupted id must never appear");
  assert.equal(harness.selectedExchangeId(), BIG_ID);
});

test("remembered exchange ids round-trip 64-bit values through localStorage", async () => {
  const harness = await createHarness();
  harness.el("manualExchangeId").value = BIGINT_MAX;
  harness.el("addExchange").click();
  await harness.flush();

  const stored = JSON.parse(harness.window.localStorage.getItem("eda-exchange-bot.remembered-exchanges"));
  assert.ok(stored.includes(BIGINT_MAX), `expected ${BIGINT_MAX} in ${JSON.stringify(stored)}`);
  assert.ok(harness.exchangeOptionValues().includes(BIGINT_MAX));
  assert.ok(harness.statusText().includes(BIGINT_MAX));
});

test("invalid or out-of-range manual exchange ids are rejected", async () => {
  const harness = await createHarness();
  for (const bad of ["0", "-5", "abc", "1.5", "01", "1e10", "", ABOVE_BIGINT_MAX]) {
    harness.el("manualExchangeId").value = bad;
    harness.el("addExchange").click();
    await harness.flush();
    assert.ok(
      harness.el("status").className.includes("error"),
      `expected rejection for ${JSON.stringify(bad)}, status: ${harness.statusText()}`
    );
    const stored = JSON.parse(harness.window.localStorage.getItem("eda-exchange-bot.remembered-exchanges") || "[]");
    assert.ok(!stored.includes(bad), `${JSON.stringify(bad)} must not be remembered`);
  }
});

test("exchange options sort numerically beyond Number.MAX_SAFE_INTEGER", async () => {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([
    exchangeRow({ exchange_id: BIG_ID }),
    exchangeRow({ exchange_id: "10" }),
    exchangeRow({ exchange_id: "9" }),
    exchangeRow({ exchange_id: BIGINT_MAX })
  ]);
  // "1" is remembered from the harness's initial exchange load; it has no
  // access points so it sorts after the live exchanges.
  assert.deepEqual(harness.exchangeOptionValues(), ["9", "10", BIG_ID, BIGINT_MAX, "1"]);
});

test("seed SQL targets the exact 64-bit exchange id", async () => {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: BIG_ID })]);
  const sql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(sql, `seed write did not run: ${harness.statusText()}`);
  assert.ok(sql.includes(`v_exchange_id := ${BIG_ID};`), "seed SQL must assign the exact id");
  assert.ok(!sql.includes(CORRUPTED_BIG_ID), "seed SQL must not contain the precision-corrupted id");
});

test("buyback SQL targets the exact 64-bit exchange id", async () => {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: BIGINT_MAX })]);
  const sql = await harness.clickAndCaptureSql("buySweep");
  assert.ok(sql, `buyback write did not run: ${harness.statusText()}`);
  assert.ok(sql.includes(`o.exchange_id = ${BIGINT_MAX}`), "buyback SQL must filter on the exact id");
  assert.ok(!sql.includes("e+"), "buyback SQL must not contain scientific notation ids");
});

test("buyback sweep keeps its captured exchange while classification is pending", async () => {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([
    exchangeRow({ exchange_id: "77" }),
    exchangeRow({ exchange_id: "88" })
  ]);
  assert.equal(harness.selectedExchangeId(), "77");

  const classificationRow = {
    order_id: "701",
    template_id: "TestOre",
    quality_level: "0",
    item_price: "250",
    stack_size: "100",
    max_unit_price: "300",
    result_code: "0",
    result_label: "eligible",
    detail: "ask 250 <= cap 300"
  };
  let finishClassification;
  const pendingClassification = new Promise((resolve) => {
    finishClassification = resolve;
  });
  let classificationRequests = 0;
  harness.onQuery = async ({ query }) => {
    if (String(query).includes("result_code") && String(query).includes("price too high")) {
      classificationRequests += 1;
      if (classificationRequests === 1) return pendingClassification;
    }
    return { rows: [] };
  };
  harness.onExecute = async () => ({
    rows: [{ buyback_report: JSON.stringify({ log: [{ ...classificationRow, result_label: "success" }] }) }]
  });

  harness.el("buySweep").click();
  await harness.waitFor(() => classificationRequests === 1, { label: "paused buyback classification" });
  harness.setValue("exchangeId", "88");
  finishClassification({ rows: [classificationRow] });

  await harness.waitFor(() => harness.executedSql().length === 1, { label: "captured-exchange buyback write" });
  await harness.waitFor(() => harness.el("buybackLog").textContent.includes("Exchange 77"), { label: "exchange-scoped log heading" });

  const sql = harness.executedSql()[0];
  assert.ok(sql.includes("o.exchange_id = 77"), "write SQL must retain the exchange selected at sweep start");
  assert.ok(!sql.includes("o.exchange_id = 88"), "write SQL must not follow a selector change during classification");
  assert.match(harness.el("buybackLog").querySelector("h3").textContent, /Exchange 77/);
  assert.match(harness.el("buybackLogMeta").textContent, /Exchange 77/);

  const stored = JSON.parse(harness.window.localStorage.getItem("eda-exchange-bot.buyback-log"));
  assert.equal(stored[0].exchange_id, "77");
});
