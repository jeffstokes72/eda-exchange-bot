"use strict";

// Server-side market reseed schedule: mirrors buyback's scheduler.* wiring
// using scheduler.seed.schedule.get/set and scheduler.seed.run.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function seedScheduleFixture(overrides = {}) {
  return {
    enabled: false,
    intervalMinutes: 15,
    exchangeId: "",
    priceMultiplier: 5,
    lastRunAt: "",
    lastRunStatus: "",
    lastRunDetail: "",
    nextRunAt: "",
    ...overrides
  };
}

function buybackScheduleFixture(overrides = {}) {
  return {
    enabled: false,
    intervalMinutes: 30,
    exchangeId: "",
    priceMultiplier: 5,
    buybackPercent: 60,
    maxBuys: 500,
    lastRunAt: "",
    lastRunStatus: "",
    lastRunDetail: "",
    nextRunAt: "",
    ...overrides
  };
}

async function seedSupportedHarness(seedSchedule = seedScheduleFixture(), onScheduler = null) {
  const harness = await createHarness({
    onScheduler: onScheduler || (async (action) => {
      if (action === "scheduler.schedule.get") return buybackScheduleFixture();
      if (action === "scheduler.seed.schedule.get") return seedSchedule;
      throw new Error(`Unsupported addon action: ${action}`);
    })
  });
  await harness.waitFor(
    () => !harness.el("serverSeedScheduleSection").hidden,
    { label: "server seed schedule section to appear" }
  );
  return harness;
}

test("older console keeps the seed schedule section hidden", async () => {
  const harness = await createHarness();
  await harness.flush();
  assert.equal(harness.el("serverSeedScheduleSection").hidden, true);
  assert.equal(harness.el("autoSeed").disabled, false);
  assert.equal(harness.el("autoSeedInterval").value, "15");
  assert.ok(
    harness.schedulerCalls("scheduler.seed.schedule.get").length >= 1,
    "feature detection probes scheduler.seed.schedule.get"
  );
});

test("supported console shows the seed schedule and populates saved values", async () => {
  const harness = await seedSupportedHarness(seedScheduleFixture({
    enabled: true,
    intervalMinutes: 20,
    exchangeId: "9007199254740993",
    priceMultiplier: 7,
    lastRunAt: "2026-08-06T00:00:00.000Z",
    lastRunStatus: "seeded",
    lastRunDetail: "Seeded 100 listings",
    nextRunAt: "2026-08-06T00:20:00.000Z"
  }));

  assert.equal(harness.el("serverSeedScheduleEnabled").checked, true);
  assert.equal(harness.el("serverSeedIntervalMinutes").value, "20");
  assert.equal(harness.el("serverSeedPriceMultiplier").value, "7");
  const status = harness.el("serverSeedScheduleStatus").textContent;
  assert.match(status, /enabled, every 20 min on exchange 9007199254740993/);
  assert.match(status, /seeded/);
  assert.match(status, /Seeded 100 listings/);
});

test("saving maps the seed form to scheduler.seed.schedule.set with a string exchangeId", async () => {
  let setPayload = null;
  const harness = await seedSupportedHarness(seedScheduleFixture(), async (action, payload) => {
    if (action === "scheduler.schedule.get") return buybackScheduleFixture();
    if (action === "scheduler.seed.schedule.get") return seedScheduleFixture();
    if (action === "scheduler.seed.schedule.set") {
      setPayload = payload;
      return seedScheduleFixture({ ...payload.schedule, nextRunAt: "2026-08-06T01:00:00.000Z" });
    }
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "9007199254740993" })]);

  harness.setValue("serverSeedIntervalMinutes", 15);
  harness.setValue("serverSeedPriceMultiplier", 6);
  harness.el("serverSeedScheduleEnabled").checked = true;
  harness.el("saveServerSeedSchedule").click();
  await harness.waitFor(() => setPayload !== null, { label: "scheduler.seed.schedule.set" });

  assert.deepEqual(plain(setPayload), {
    schedule: {
      enabled: true,
      intervalMinutes: 15,
      priceMultiplier: 6,
      exchangeId: "9007199254740993"
    }
  });
  assert.equal(typeof setPayload.schedule.exchangeId, "string");
});

test("Run Reseed Now calls scheduler.seed.run and shows the result", async () => {
  let runCalls = 0;
  const harness = await seedSupportedHarness(seedScheduleFixture({ exchangeId: "77" }), async (action) => {
    if (action === "scheduler.schedule.get") return buybackScheduleFixture();
    if (action === "scheduler.seed.schedule.get") return seedScheduleFixture({ exchangeId: "77" });
    if (action === "scheduler.seed.run") {
      runCalls += 1;
      return {
        status: "seeded",
        listingCount: "5874",
        exchangeId: "77",
        detail: "Seeded 5874 listings on exchange 77 at 5x (bot listings cleared first).",
        schedule: seedScheduleFixture({
          exchangeId: "77",
          lastRunAt: "2026-08-06T00:00:00.000Z",
          lastRunStatus: "seeded",
          lastRunDetail: "Seeded 5874 listings"
        })
      };
    }
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);

  harness.el("serverSeedRun").click();
  await harness.waitFor(() => runCalls === 1, { label: "scheduler.seed.run" });
  await harness.waitFor(
    () => harness.el("serverSeedScheduleStatus").textContent.includes("reseed finished"),
    { label: "server reseed completion" }
  );
  assert.match(harness.el("serverSeedScheduleStatus").textContent, /5,874 listings on exchange 77/);
  assert.equal(harness.executedSql().length, 0, "server reseed must not send SQL from the iframe");
});

test("an enabled server seed schedule turns off and disables in-page auto reseed", async () => {
  let schedule = seedScheduleFixture({ exchangeId: "77" });
  const harness = await seedSupportedHarness(schedule, async (action) => {
    if (action === "scheduler.schedule.get") return buybackScheduleFixture();
    if (action === "scheduler.seed.schedule.get") return schedule;
    throw new Error(`Unsupported addon action: ${action}`);
  });
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);

  harness.setCheckbox("autoSeed", true);
  assert.equal(harness.el("autoSeed").checked, true);

  schedule = seedScheduleFixture({ exchangeId: "77", enabled: true, nextRunAt: "2026-08-06T01:00:00.000Z" });
  harness.el("refreshServerSeedSchedule").click();
  await harness.waitFor(() => harness.el("autoSeed").disabled, { label: "in-page auto seed disabled" });
  assert.equal(harness.el("autoSeed").checked, false);
  assert.match(harness.autoStatusText(), /server-side schedule reseeds unattended/);
});

test("in-page auto reseed still force-clears when the server seed job is unavailable", async () => {
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);
  harness.setCheckbox("clearExisting", false);
  harness.setValue("autoSeedInterval", 15);
  harness.setCheckbox("autoSeed", true);

  let seedSql = null;
  harness.onExecute = async ({ query }) => {
    seedSql = String(query || "");
    return { rows: [] };
  };

  harness.advanceTime(15 * 60000);
  harness.autoTick();
  await harness.waitFor(() => seedSql !== null, { label: "auto reseed write" });
  assert.match(seedSql, /DELETE FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id/);
});
