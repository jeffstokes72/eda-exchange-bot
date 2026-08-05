"use strict";

// Bug: buyback operations re-read the exchange selector (and the pricing
// inputs) at every step. A sweep is a chain of awaits — pre-classify, write,
// post-write verification, log batch — so moving the selector while a
// classification request was in flight could write to one exchange and verify
// or log another, mixing several exchanges into one Buyback Sweep Log.
// Each operation now captures those inputs once and passes them explicitly.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

const CAPTURED = "77";
const SWITCHED = "88";
const SWITCHED_AGAIN = "99";
// Ids the selector is moved to mid-operation. No generated statement may ever
// filter on one of them.
const NEVER_TARGETED = [SWITCHED, SWITCHED_AGAIN];

// Matches the read-only classification query (dry-run log + pre/post sweep).
// The write sweep goes through database.execute, not database.query.
function isClassifyQuery(query) {
  return query.includes("result_label") && query.includes("ORDER BY");
}

function eligibleRow(overrides = {}) {
  return {
    order_id: "555",
    template_id: "TestOre",
    quality_level: "0",
    item_price: "250",
    stack_size: "100",
    max_unit_price: "300",
    result_code: "0",
    result_label: "eligible",
    detail: "ask 250/unit <= cap 300",
    ...overrides
  };
}

function pausable() {
  let release = () => {};
  const paused = new Promise((resolve) => { release = resolve; });
  return { paused, release: () => release() };
}

async function twoExchangeHarness() {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([
    exchangeRow({ exchange_id: CAPTURED, access_point_count: "1" }),
    exchangeRow({ exchange_id: SWITCHED, access_point_count: "1" })
  ]);
  assert.equal(harness.selectedExchangeId(), CAPTURED, "the exchange with access points is preselected");
  return harness;
}

// Moves the selector without going through setValue: no change listener is
// involved, exactly like an admin picking another exchange mid-sweep.
function selectExchange(harness, exchangeId) {
  harness.el("exchangeId").value = exchangeId;
}

function logBatches(harness) {
  return Array.from(harness.el("buybackLog").querySelectorAll(".buyback-log-batch"));
}

// The empty-log placeholder lists every result code, so waiting on log text
// alone would match before a batch has rendered.
async function waitForBatches(harness, count) {
  await harness.waitFor(() => logBatches(harness).length >= count, { label: `${count} rendered log batch(es)` });
  return logBatches(harness);
}

function batchText(harness, index = 0) {
  return logBatches(harness)[index].textContent;
}

function batchHeading(harness, index = 0) {
  return logBatches(harness)[index].querySelector("h3").textContent;
}

function assertScopedTo(query, label) {
  assert.ok(query.includes(`o.exchange_id = ${CAPTURED}`), `${label} must stay on exchange ${CAPTURED}`);
  for (const other of NEVER_TARGETED) {
    assert.ok(!query.includes(`o.exchange_id = ${other}`), `${label} must not follow the selector to ${other}`);
  }
}

test("a sweep keeps its captured exchange when the selector changes mid-flight", async () => {
  const harness = await twoExchangeHarness();
  const classifyQueries = [];
  const confirmQueries = [];
  const preClassify = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      if (classifyQueries.length === 1) {
        // Hold the pre-sweep classification open so the selector can move
        // while the sweep is mid-flight.
        await preClassify.paused;
        return { rows: [eligibleRow()] };
      }
      // Post-write: the bought listing is gone.
      return { rows: [] };
    }
    if (text.includes("dune_exchange_fulfilled_orders")) {
      confirmQueries.push(text);
      return { rows: [{ order_id: "555" }] };
    }
    return { rows: [] };
  };
  // A bridge that discards execute SELECT rows, so the sweep also runs the
  // post-write classify/verify fallback instead of reading a buyback_report.
  harness.onExecute = async () => ({ rows: [] });

  harness.el("buySweep").click();
  await harness.waitFor(() => classifyQueries.length === 1, { label: "pre-sweep classification" });
  selectExchange(harness, SWITCHED);
  preClassify.release();

  await harness.waitFor(() => harness.executedSql().length === 1, { label: "buyback write" });
  await waitForBatches(harness, 1);

  assertScopedTo(harness.executedSql()[0], "write SQL");
  assert.equal(harness.selectedExchangeId(), SWITCHED, "the selector itself still shows the admin's new choice");
  assert.equal(classifyQueries.length, 2, "sweep classifies before and after the write");
  for (const query of classifyQueries) assertScopedTo(query, "classification");
  assert.equal(confirmQueries.length, 1, "the vanished listing is confirmed through the fulfilled-order audit");

  const logText = batchText(harness);
  assert.match(batchHeading(harness), /Exchange 77/, "the batch heading names the swept exchange");
  assert.doesNotMatch(logText, /Exchange 88/, "the batch is never attributed to another exchange");
  assert.match(logText, /0x0/, "the confirmed listing is logged as bought");
  assert.match(harness.el("buybackLogMeta").textContent, /Exchange 77/, "the latest-log summary names the exchange");
  assert.match(harness.statusText(), /complete on exchange 77/);

  const stored = JSON.parse(harness.window.localStorage.getItem("eda-exchange-bot.buyback-log"));
  assert.equal(stored[0].exchange_id, CAPTURED, "stored batches keep the exchange they classified");
});

test("the selector may change during every asynchronous stage without moving the sweep", async () => {
  // One sweep, one selector move per await: pre-classify, the write itself,
  // and the post-write verification (classify, then the fulfilled-order audit).
  const harness = await createHarness();
  await harness.loadExchangesWithRows([
    exchangeRow({ exchange_id: CAPTURED, access_point_count: "1" }),
    exchangeRow({ exchange_id: SWITCHED, access_point_count: "1" }),
    exchangeRow({ exchange_id: SWITCHED_AGAIN, access_point_count: "1" })
  ]);
  assert.equal(harness.selectedExchangeId(), CAPTURED);

  const classifyQueries = [];
  const confirmQueries = [];
  const writes = [];
  const preClassify = pausable();
  const write = pausable();
  const postClassify = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      if (classifyQueries.length === 1) {
        await preClassify.paused;
        return { rows: [eligibleRow()] };
      }
      await postClassify.paused;
      return { rows: [] };
    }
    if (text.includes("dune_exchange_fulfilled_orders")) {
      confirmQueries.push(text);
      return { rows: [{ order_id: "555" }] };
    }
    return { rows: [] };
  };
  harness.onExecute = async ({ query }) => {
    writes.push(String(query || ""));
    await write.paused;
    return { rows: [] };
  };

  harness.el("buySweep").click();
  await harness.waitFor(() => classifyQueries.length === 1, { label: "pre-sweep classification" });
  selectExchange(harness, SWITCHED);
  preClassify.release();

  await harness.waitFor(() => writes.length === 1, { label: "write execution" });
  selectExchange(harness, SWITCHED_AGAIN);
  write.release();

  await harness.waitFor(() => classifyQueries.length === 2, { label: "post-write classification" });
  selectExchange(harness, SWITCHED);
  postClassify.release();

  await harness.waitFor(() => confirmQueries.length === 1, { label: "fulfilled-order verification" });
  await waitForBatches(harness, 1);

  for (const query of classifyQueries) assertScopedTo(query, "classification");
  assertScopedTo(writes[0], "write SQL");
  assertScopedTo(confirmQueries[0], "fulfilled-order verification");
  assert.match(batchHeading(harness), /Exchange 77/);
  assert.match(batchText(harness), /0x0/);
  assert.equal(
    JSON.parse(harness.window.localStorage.getItem("eda-exchange-bot.buyback-log"))[0].exchange_id,
    CAPTURED
  );
});

test("a missing buyback_report is resolved from the captured exchange's audit rows", async () => {
  // Bridges that discard execute SELECT rows return no buyback_report, so the
  // sweep diffs its own classification and confirms each vanished listing
  // against the fulfilled-order audit — all on the captured exchange.
  const harness = await twoExchangeHarness();
  const classifyQueries = [];
  const confirmQueries = [];
  const preClassify = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      if (classifyQueries.length === 1) {
        await preClassify.paused;
        return { rows: [eligibleRow()] };
      }
      return { rows: [] };
    }
    if (text.includes("dune_exchange_fulfilled_orders")) {
      confirmQueries.push(text);
      return { rows: [{ order_id: "555" }] };
    }
    return { rows: [] };
  };
  harness.onExecute = async () => ({ rows: [], status: "executed" });

  harness.el("buySweep").click();
  await harness.waitFor(() => classifyQueries.length === 1, { label: "pre-sweep classification" });
  selectExchange(harness, SWITCHED);
  preClassify.release();
  await harness.waitFor(() => confirmQueries.length === 1, { label: "fulfilled-order verification" });
  await waitForBatches(harness, 1);

  assertScopedTo(confirmQueries[0], "fulfilled-order verification");
  assert.ok(confirmQueries[0].includes("555"), "the vanished listing is the one being confirmed");
  const logText = batchText(harness);
  assert.match(logText, /0x0/);
  assert.match(logText, /success/, "a confirmed payment row resolves to 0x0 success");
  assert.match(harness.statusText(), /1 bought, 0 not bought/);
  assert.match(batchHeading(harness), /Exchange 77/);
});

test("a missing buyback_report with no audit row never invents a success", async () => {
  const harness = await twoExchangeHarness();
  const classifyQueries = [];
  const preClassify = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      if (classifyQueries.length === 1) {
        await preClassify.paused;
        return { rows: [eligibleRow()] };
      }
      return { rows: [] };
    }
    // No payment row for the vanished listing (concurrent removal, or a bridge
    // that dropped the report).
    if (text.includes("dune_exchange_fulfilled_orders")) return { rows: [] };
    return { rows: [] };
  };
  harness.onExecute = async () => ({ rows: [] });

  harness.el("buySweep").click();
  await harness.waitFor(() => classifyQueries.length === 1, { label: "pre-sweep classification" });
  selectExchange(harness, SWITCHED);
  preClassify.release();
  await waitForBatches(harness, 1);

  const logText = batchText(harness);
  assert.match(logText, /0x6/);
  assert.match(logText, /skipped locked/);
  assert.doesNotMatch(logText, /0x0/, "an unconfirmed listing must never be logged as bought");
  assert.match(harness.statusText(), /0 bought, 1 not bought/);
  assert.match(batchHeading(harness), /Exchange 77/);
});

test("malformed and out-of-range exchange ids never reach SQL", async () => {
  // The selector is the only source of exchange ids in the UI, but the ids now
  // travel as arguments into string-interpolated SQL, so every buyback builder
  // re-validates them as a positive PostgreSQL BIGINT.
  const harness = await twoExchangeHarness();
  const select = harness.el("exchangeId");
  const validOptions = select.innerHTML;
  const badIds = [
    "0",
    "-5",
    "1.5",
    "01",
    "1e10",
    "abc",
    "9223372036854775808", // PostgreSQL BIGINT max + 1
    "99999999999999999999999",
    "77; DROP TABLE dune.items",
    "77 OR 1=1",
    "77,88"
  ];

  for (const bad of badIds) {
    select.innerHTML = `<option value="${bad}">broken</option>`;
    select.value = bad;
    assert.equal(select.value, bad, `the selector must hold ${JSON.stringify(bad)} for this check`);
    const callsBefore = harness.bridgeCalls.length;

    harness.el("buySweep").click();
    await harness.flush();
    assert.ok(
      harness.el("status").className.includes("error"),
      `sweep must refuse ${JSON.stringify(bad)}, status: ${harness.statusText()}`
    );
    assert.match(harness.statusText(), /invalid|Choose an exchange/);

    harness.el("refreshBuybackLog").click();
    await harness.flush();
    assert.ok(
      harness.el("status").className.includes("error"),
      `dry-run must refuse ${JSON.stringify(bad)}, status: ${harness.statusText()}`
    );

    assert.equal(
      harness.bridgeCalls.length,
      callsBefore,
      `no bridge request may carry ${JSON.stringify(bad)}`
    );
    assert.equal(harness.confirmMessages.length, 0, "no backup confirmation for an unusable exchange");
  }

  select.innerHTML = validOptions;
  select.value = CAPTURED;
});

test("an automatic sweep writes to the exchange its eligibility probe measured", async () => {
  const harness = await twoExchangeHarness();
  harness.setCheckbox("autoBuyback", true);
  const eligibilityQueries = [];
  const classifyQueries = [];
  const probe = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (text.includes("eligible_orders")) {
      eligibilityQueries.push(text);
      await probe.paused;
      return { rows: [{ eligible_orders: "2" }] };
    }
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      return { rows: [] };
    }
    return { rows: [] };
  };
  harness.onExecute = async () => ({ rows: [] });

  harness.advanceTime(31 * 60000);
  harness.autoTick();
  await harness.waitFor(() => eligibilityQueries.length === 1, { label: "eligibility probe" });
  selectExchange(harness, SWITCHED);
  probe.release();

  await harness.waitFor(() => harness.executedSql().length === 1, { label: "auto sweep write" });
  await harness.waitFor(() => harness.autoStatusText().includes("sweep finished"), { label: "auto sweep completion" });

  assertScopedTo(eligibilityQueries[0], "eligibility probe");
  assertScopedTo(harness.executedSql()[0], "auto write SQL");
  for (const query of classifyQueries) assertScopedTo(query, "auto classification");
  await waitForBatches(harness, 1);
  assert.match(batchHeading(harness), /Auto buyback sweep\s*Exchange 77/);
});

test("an idle auto tick logs the exchange it probed", async () => {
  const harness = await twoExchangeHarness();
  harness.setCheckbox("autoBuyback", true);
  const classifyQueries = [];
  const probe = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (text.includes("eligible_orders")) {
      await probe.paused;
      return { rows: [{ eligible_orders: "0" }] };
    }
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      return { rows: [eligibleRow({ result_code: "1", result_label: "price too high", item_price: "400" })] };
    }
    return { rows: [] };
  };

  harness.advanceTime(31 * 60000);
  harness.autoTick();
  await harness.waitFor(() => harness.bridgeCalls.some((call) => String(call.query || "").includes("eligible_orders")), { label: "eligibility probe" });
  selectExchange(harness, SWITCHED);
  probe.release();

  await harness.waitFor(() => harness.autoStatusText().includes("nothing eligible"), { label: "idle auto tick" });
  assert.equal(harness.executedSql().length, 0, "an idle tick takes no backup and runs no write");
  assert.equal(classifyQueries.length, 1);
  assertScopedTo(classifyQueries[0], "idle classification");
  await waitForBatches(harness, 1);
  assert.match(batchHeading(harness), /Auto buyback \(idle\)\s*Exchange 77/);
  assert.match(harness.autoStatusText(), /nothing eligible on exchange 77/);
});

test("Refresh Log (dry-run) attributes its batch to the exchange it queried", async () => {
  const harness = await twoExchangeHarness();
  const classifyQueries = [];
  const classify = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      await classify.paused;
      return { rows: [eligibleRow()] };
    }
    return { rows: [] };
  };

  harness.el("refreshBuybackLog").click();
  await harness.waitFor(() => classifyQueries.length === 1, { label: "dry-run classification" });
  selectExchange(harness, SWITCHED);
  classify.release();

  await waitForBatches(harness, 1);
  assertScopedTo(classifyQueries[0], "dry-run classification");
  assert.match(batchHeading(harness), /Dry-run classify\s*Exchange 77/);
  assert.doesNotMatch(batchText(harness), /Exchange 88/);
  assert.match(harness.statusText(), /classified on exchange 77/);
  assert.equal(harness.executedSql().length, 0, "the dry-run never writes");
});

test("a sweep writes with the pricing inputs it started with", async () => {
  // Same class of bug as the exchange: threshold, multiplier, and Max Buys are
  // read into SQL, so a change while the pre-classify request is in flight
  // could write caps the logged classification never used.
  const harness = await twoExchangeHarness();
  harness.setValue("maxBuys", 5);
  harness.setValue("buybackPercent", 60);
  const classifyQueries = [];
  const preClassify = pausable();

  harness.onQuery = async ({ query }) => {
    const text = String(query || "");
    if (isClassifyQuery(text)) {
      classifyQueries.push(text);
      if (classifyQueries.length === 1) {
        await preClassify.paused;
        return { rows: [eligibleRow()] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  };
  harness.onExecute = async () => ({ rows: [] });

  harness.el("buySweep").click();
  await harness.waitFor(() => classifyQueries.length === 1, { label: "pre-sweep classification" });
  harness.setValue("maxBuys", 1);
  harness.setValue("buybackPercent", 50);
  harness.setValue("priceMultiplier", 10);
  preClassify.release();

  await harness.waitFor(() => harness.executedSql().length === 1, { label: "buyback write" });
  const sql = harness.executedSql()[0];
  // TestOre is seeded at 500 for multiplier 5, so 60% is a 300/unit cap.
  assert.ok(sql.includes("('TestOre',0,300)"), "caps must come from the multiplier and threshold the sweep started with");
  assert.ok(!sql.includes("('TestOre',0,250)"), "the mid-sweep 50% threshold must not reach the write");
  assert.ok(!sql.includes("('TestOre',0,600)"), "the mid-sweep 10x multiplier must not reach the write");
  assert.ok(sql.includes("LIMIT 5 FOR UPDATE"), "the write must use the Max Buys the sweep started with");
  assert.ok(sql.includes("v_solari, 60, 5);"), "the reported threshold and Max Buys must match the write");
  // The post-write leftover ranking uses the same limit, never the new one.
  assert.ok(sql.includes("r.rn > 5 THEN 5 ELSE 6"), "leftover ranking must use the captured Max Buys");
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
          order_id: "1",
          template_id: "TestOre",
          quality_level: "0",
          item_price: "400",
          stack_size: "100",
          max_unit_price: "300",
          result_code: 1,
          result_hex: "0x1",
          result_label: "price too high",
          detail: "ask 400 > cap 300"
        }]
      }])
    }
  });

  const logText = batchText(harness);
  assert.match(batchHeading(harness), /Legacy exchange unknown/, "batches saved before 0.13.4 must still render");
  assert.match(logText, /price too high/, "their rows must stay readable");
  assert.match(logText, /TestOre/);
  assert.match(harness.el("buybackLogMeta").textContent, /Legacy exchange unknown/);
});

test("buyback actions without a usable exchange report an error instead of failing silently", async () => {
  // The capture throws when nothing is selected. It has to be caught and shown:
  // an unhandled rejection would leave the admin with no feedback at all (and
  // fails this suite outright).
  const harness = await createHarness({
    onQuery: async () => { throw new Error("exchange lookup unavailable"); }
  });
  assert.equal(harness.selectedExchangeId(), "", "no exchange is selectable after a failed lookup");

  harness.el("buySweep").click();
  await harness.waitFor(() => harness.statusText().includes("Choose an exchange"), { label: "sweep rejection" });
  assert.equal(harness.executedSql().length, 0, "no write and no backup without an exchange");
  assert.equal(harness.confirmMessages.length, 0, "the sweep is refused before the backup confirmation");

  harness.el("refreshBuybackLog").click();
  await harness.waitFor(() => harness.statusText().includes("Choose an exchange"), { label: "dry-run rejection" });
  assert.ok(harness.el("status").className.includes("error"));
});

test("an unusable selector value fails one auto tick without wedging market ops", async () => {
  const harness = await twoExchangeHarness();
  harness.setCheckbox("autoBuyback", true);
  harness.setValue("autoSeedInterval", 60);
  harness.setCheckbox("autoSeed", true);
  let probes = 0;
  let seeds = 0;
  harness.onQuery = async ({ query }) => {
    if (String(query || "").includes("eligible_orders")) {
      probes += 1;
      return { rows: [{ eligible_orders: "0" }] };
    }
    return { rows: [] };
  };
  harness.onExecute = async ({ query }) => {
    if (String(query || "").includes("market_seed_plan")) seeds += 1;
    return { rows: [] };
  };

  // A selector value that is not a BIGINT exchange id: the tick must fail
  // loudly and still release the auto-run lock, or every later automatic
  // buyback, seed, and cleanup tick would be skipped for the session.
  const select = harness.el("exchangeId");
  const broken = harness.document.createElement("option");
  broken.value = "0";
  broken.textContent = "Broken option";
  select.appendChild(broken);
  select.value = "0";

  // The buyback tick comes first: it is due at 30 min, the seed job only at 60.
  harness.advanceTime(31 * 60000);
  harness.autoTick();
  await harness.waitFor(() => harness.autoStatusText().includes("Auto buyback failed"), { label: "failed auto tick" });
  assert.equal(probes, 0, "no probe may run without a usable exchange");
  assert.equal(seeds, 0);

  // autoRunning is shared by all three in-page jobs, so the seed job proves the
  // lock was released by the finally block, not just re-armed for buyback.
  selectExchange(harness, CAPTURED);
  harness.advanceTime(30 * 60000);
  harness.autoTick();
  await harness.waitFor(() => seeds === 1, { label: "recovered auto seed" });
  await harness.waitFor(() => harness.autoStatusText().includes("Auto seed: finished"), { label: "auto seed completion" });

  harness.setCheckbox("autoSeed", false);
  harness.advanceTime(31 * 60000);
  harness.autoTick();
  await harness.waitFor(() => probes === 1, { label: "recovered auto buyback tick" });
  await harness.waitFor(() => harness.autoStatusText().includes("nothing eligible on exchange 77"), { label: "recovered idle status" });
});
