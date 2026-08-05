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

// A buyback sweep is a chain of awaits (pre-classify, write, post-write
// verification, log batch). Re-reading the selector at each step let an
// exchange switch mid-sweep write to one exchange while verifying and logging
// another; the exchange id is now captured once per operation.
test("a sweep keeps its captured exchange when the selector changes mid-flight", async () => {
  const harness = await createHarness();
  const rows = [
    exchangeRow({ exchange_id: "77", access_point_count: "1" }),
    exchangeRow({ exchange_id: "88", access_point_count: "1" })
  ];
  await harness.loadExchangesWithRows(rows);
  harness.el("exchangeId").value = "77";

  const classifyQueries = [];
  let releaseClassify = () => {};
  const classifyPaused = new Promise((resolve) => { releaseClassify = resolve; });

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (text.includes("known_exchanges")) return { rows };
    if (text.includes("result_label")) {
      classifyQueries.push(text);
      if (classifyQueries.length === 1) {
        // Hold the pre-sweep classification open so the selector can move
        // while the sweep is mid-flight.
        await classifyPaused;
        return {
          rows: [{
            order_id: "555", template_id: "TestOre", quality_level: "0", item_price: "250",
            stack_size: "100", max_unit_price: "300", result_code: "0",
            result_label: "eligible", detail: "ask 250 <= cap 300"
          }]
        };
      }
      // Post-write classification: the bought listing is gone.
      return { rows: [] };
    }
    if (text.includes("dune_exchange_fulfilled_orders")) return { rows: [{ order_id: "555" }] };
    return { rows: [] };
  };
  // A bridge that discards execute SELECT rows, so the sweep also runs the
  // post-write classify/verify fallback.
  harness.onExecute = async () => ({ rows: [] });

  harness.el("buySweep").click();
  await harness.waitFor(() => classifyQueries.length === 1, { label: "pre-sweep classification" });

  harness.el("exchangeId").value = "88";
  releaseClassify();

  await harness.waitFor(() => harness.executedSql().length > 0, { label: "buyback write" });
  await harness.waitFor(() => harness.el("buybackLog").textContent.includes("0x0"), { label: "buyback log batch" });

  const sql = harness.executedSql().at(-1);
  assert.ok(sql.includes("o.exchange_id = 77"), `write SQL must stay on exchange 77: ${sql.slice(0, 400)}`);
  assert.ok(!sql.includes("o.exchange_id = 88"), "write SQL must not target the newly selected exchange");
  assert.equal(harness.selectedExchangeId(), "88", "the selector itself still shows the admin's new choice");

  assert.ok(classifyQueries.length >= 2, "sweep must classify before and after the write");
  for (const query of classifyQueries) {
    assert.ok(query.includes("o.exchange_id = 77"), "every classification must stay on the captured exchange");
    assert.ok(!query.includes("o.exchange_id = 88"), "no classification may follow the selector");
  }

  const logText = harness.el("buybackLog").textContent;
  assert.match(logText, /Exchange 77/, "log batch heading must name the swept exchange");
  assert.doesNotMatch(logText, /Exchange 88/, "log batch must not be attributed to another exchange");
  assert.match(harness.el("buybackLogMeta").textContent, /Exchange 77/);
  const stored = JSON.parse(harness.window.localStorage.getItem("eda-exchange-bot.buyback-log"));
  assert.equal(stored[0].exchange_id, "77", "stored batches keep the exchange they classified");
});

test("log batches stored without an exchange id stay visible as legacy", async () => {
  const harness = await createHarness({
    localStorage: {
      "eda-exchange-bot.buyback-log": JSON.stringify([{
        source: "Run buyback sweep",
        at: "1/1/2026, 12:00:00 AM",
        note: "",
        summary: "1 listing(s); 0x1×1",
        entries: [{
          order_id: "1", template_id: "TestOre", quality_level: "0", item_price: "400",
          stack_size: "100", max_unit_price: "300", result_code: 1, result_hex: "0x1",
          result_label: "price too high", detail: "ask 400 > cap 300"
        }]
      }])
    }
  });

  const logText = harness.el("buybackLog").textContent;
  assert.match(logText, /Legacy exchange unknown/, "pre-0.13.3 batches must still render");
  assert.match(logText, /price too high/);
  assert.match(harness.el("buybackLogMeta").textContent, /Legacy exchange unknown/);
});
