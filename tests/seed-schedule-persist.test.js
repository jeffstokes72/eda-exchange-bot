"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, exchangeRow } = require("./helpers/harness");

test("in-page auto reseed next-run time survives a page reload", async () => {
  const first = await createHarness();
  await first.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);
  first.setValue("autoSeedInterval", 15);
  first.setCheckbox("autoSeed", true);
  await first.flush();

  const saved = JSON.parse(first.window.localStorage.getItem("eda-exchange-bot.settings"));
  assert.equal(saved.autoSeed, true);
  assert.ok(Number(saved.nextAutoSeedAt) > Date.now(), "enabling must schedule a future next run");
  const scheduledAt = Number(saved.nextAutoSeedAt);

  const second = await createHarness({
    localStorage: {
      "eda-exchange-bot.settings": JSON.stringify(saved)
    }
  });
  await second.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);
  assert.equal(second.el("autoSeed").checked, true);

  let seedSql = null;
  second.onExecute = async ({ query }) => {
    seedSql = String(query || "");
    return { rows: [] };
  };

  // Still before the saved next run — must not fire yet.
  second.autoTick();
  await second.flush();
  assert.equal(seedSql, null, "reload must not reset the timer to fire immediately");

  // Jump past the saved next-run timestamp and fire.
  const waitMs = Math.max(0, scheduledAt - Date.now()) + 1000;
  second.advanceTime(waitMs);
  second.autoTick();
  await second.waitFor(() => seedSql !== null, { label: "reseed after restored timer" });
  assert.match(seedSql, /DELETE FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id/);
});

test("buyback-capable console without seed job shows the reseed unavailable note", async () => {
  const harness = await createHarness({
    onScheduler: async (action) => {
      if (action === "scheduler.schedule.get") {
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
          nextRunAt: ""
        };
      }
      throw new Error(`Unsupported addon action: ${action}`);
    }
  });
  await harness.waitFor(
    () => !harness.el("serverScheduleSection").hidden,
    { label: "buyback schedule section" }
  );
  await harness.waitFor(
    () => !harness.el("serverSeedUnavailableNote").hidden,
    { label: "seed unavailable note" }
  );
  assert.equal(harness.el("serverSeedScheduleSection").hidden, true);
  assert.match(harness.el("serverSeedUnavailableNote").textContent, /scheduler\.seed\.\*/);
});
