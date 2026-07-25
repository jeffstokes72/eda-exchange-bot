"use strict";

// Invariants for the regenerated market seed plan: baked grades, max stacks,
// durability range, and exclusion of plot/set/memento junk.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bundledSeedPlan } = require("./helpers/harness");

test("seed plan bakes schematic grades and T6 rankable gear grades", () => {
  const plan = bundledSeedPlan();
  assert.ok(plan.rows.length > 1000, "seed should be a full catalog");
  assert.equal(plan.price_multiplier, 5);

  const byTemplate = new Map();
  for (const row of plan.rows) {
    if (!byTemplate.has(row.template_id)) byTemplate.set(row.template_id, []);
    byTemplate.get(row.template_id).push(row);
  }

  const schematic = [...byTemplate.entries()].find(([, rows]) => rows.every((r) => r.kind === "schematic"));
  assert.ok(schematic, "expected at least one schematic template");
  const schematicGrades = schematic[1].map((r) => r.quality_level).sort((a, b) => a - b);
  assert.deepEqual(schematicGrades, [1, 2, 3, 4, 5], "schematics bake grades 1-5 (no stock q0)");
  assert.ok(schematic[1].every((r) => r.listings === 2));

  const dunewatcher = plan.rows.filter((r) => r.display_name === "Dunewatcher" && r.kind === "equippable");
  assert.ok(dunewatcher.length >= 6, "Dunewatcher (T6 gradeable weapon) should have stock + ranks");
  assert.deepEqual(dunewatcher.map((r) => r.quality_level).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(dunewatcher.find((r) => r.quality_level === 5).durability_max, 200);
  assert.equal(dunewatcher.find((r) => r.quality_level === 0).durability_max, 180);
});

test("commodities use catalog max stacks and durability stays in 100..200", () => {
  const plan = bundledSeedPlan();
  const spice = plan.rows.find((r) => r.display_name === "Spice Residue");
  assert.ok(spice, "Spice Residue must be listed");
  assert.equal(spice.stack_size, 1000);
  assert.equal(spice.listings, 2);

  const iron = plan.rows.find((r) => r.display_name === "Iron Ingot");
  assert.ok(iron);
  assert.equal(iron.stack_size, 500);

  for (const row of plan.rows) {
    assert.ok(row.durability_cur >= 100 && row.durability_cur <= 200, `${row.template_id} durability_cur`);
    assert.ok(row.durability_max >= 100 && row.durability_max <= 200, `${row.template_id} durability_max`);
    assert.equal(row.durability_cur, row.durability_max);
    assert.equal(row.listings, 2);
  }
});

test("seed plan excludes plot items, set packs, and social/emote/contract junk", () => {
  const plan = bundledSeedPlan();
  const names = plan.rows.map((r) => r.display_name);
  const joined = names.join("\n");
  assert.equal(names.some((n) => /zantara/i.test(n)), false);
  assert.equal(names.some((n) => /phaedra|phadera/i.test(n)), false);
  assert.equal(names.some((n) => /jackal/i.test(n)), false);
  assert.equal(/bene gesserit set/i.test(joined), false);
  assert.equal(/contract item/i.test(joined), false);
  assert.equal(/emote/i.test(joined), false);
  // Individual named armor pieces from a themed set are allowed.
  assert.ok(names.some((n) => /Acheronian/i.test(n)));
});

test("seed SQL writes absolute durability into item stats and order wear at 1.0", async () => {
  const { createHarness, exchangeRow } = require("./helpers/harness");
  const harness = await createHarness();
  await harness.loadExchangesWithRows([exchangeRow({ exchange_id: "77" })]);
  const sql = await harness.clickAndCaptureSql("seedMarket");
  assert.ok(sql);
  assert.match(sql, /item_stats TEXT NOT NULL/);
  assert.match(sql, /FItemStackAndDurabilityStats/);
  assert.match(sql, /"MaxDurability":100/);
  assert.match(sql, /rec\.template_id, 1\.0, 1\.0, rec\.category_mask/);
  assert.match(sql, /rec\.quality_level, rec\.item_stats\)/);
  assert.doesNotMatch(sql, /rec\.durability_cur, rec\.durability_max/);
});
