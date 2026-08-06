"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, bundledSeedPlan } = require("./helpers/harness");

test("seed plan panel_version matches the shipped addon version", () => {
  const plan = bundledSeedPlan();
  const addon = require("../addon.json");
  assert.equal(
    plan.panel_version,
    addon.version,
    "panel_version must match addon.json so the console status line is accurate"
  );
});

test("the page header badge and preview status show the loaded plan version", async () => {
  // The jsdom harness serves the test fixture plan (panel_version test-fixture).
  const harness = await createHarness();
  await harness.flush();
  assert.equal(harness.el("addonVersionBadge").textContent, "vtest-fixture");
  assert.match(harness.statusText(), /Preview ready from EDA Exchange Bot test-fixture/);
  assert.match(harness.document.title, /EDA Exchange Bot vtest-fixture/);
});

test("a release-shaped plan stamps the real package version into the UI", async () => {
  const addon = require("../addon.json");
  const harness = await createHarness({
    seedPlan: { ...bundledSeedPlan(), panel_version: addon.version }
  });
  await harness.flush();
  assert.equal(harness.el("addonVersionBadge").textContent, `v${addon.version}`);
  assert.match(
    harness.statusText(),
    new RegExp(`Preview ready from EDA Exchange Bot ${addon.version.replace(/\./g, "\\.")}`)
  );
  assert.equal(harness.document.title, `EDA Exchange Bot v${addon.version}`);
});
