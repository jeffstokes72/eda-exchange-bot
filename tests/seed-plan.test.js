"use strict";

// Invariants for the regenerated market seed plan: baked grades, max stacks,
// durability range, and exclusion of plot/NPC/unnamed/unreleased junk.

const test = require("node:test");
const assert = require("node:assert/strict");
const { bundledSeedPlan } = require("./helpers/harness");

test("seed plan bakes ranks only for T6 rankable gear and their schematics", () => {
  const plan = bundledSeedPlan();
  assert.ok(plan.rows.length > 1000, "seed should be a full catalog");
  assert.equal(plan.price_multiplier, 5);

  const byTemplate = new Map();
  for (const row of plan.rows) {
    if (!byTemplate.has(row.template_id)) byTemplate.set(row.template_id, []);
    byTemplate.get(row.template_id).push(row);
  }

  // Gradeable T6 weapon schematic keeps ranks 1-5.
  const smgSchematic = byTemplate.get("SMG_Unique_LargeMag_06_Schematic");
  assert.ok(smgSchematic, "expected SMG unique schematic");
  assert.deepEqual(
    smgSchematic.map((r) => r.quality_level).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
    "T6 rankable schematics bake grades 1-5 (no stock q0)"
  );
  assert.ok(smgSchematic.every((r) => r.listings === 2));

  // Non-gradeable tool schematics stay at quality 0 (no Rank 1-5).
  const compactorSchematic = byTemplate.get("StaticCompactor_Unique_Compact_06_Schematic");
  assert.ok(compactorSchematic, "expected Compact Compactor Mk6 schematic");
  assert.deepEqual(
    compactorSchematic.map((r) => r.quality_level),
    [0],
    "tool schematics must not be ranked"
  );

  const omni = plan.rows.filter((r) => r.template_id === "StaticCompactorTier6");
  assert.ok(omni.length >= 1, "Omni Static Compactor must be listed");
  assert.ok(omni.every((r) => r.quality_level === 0), "physical tools stay quality 0");

  const dunewatcher = plan.rows.filter((r) => r.display_name === "Dunewatcher" && r.kind === "equippable");
  assert.ok(dunewatcher.length >= 6, "Dunewatcher (T6 gradeable weapon) should have stock + ranks");
  assert.deepEqual(dunewatcher.map((r) => r.quality_level).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(dunewatcher.find((r) => r.quality_level === 5).durability_max, 200);
  assert.equal(dunewatcher.find((r) => r.quality_level === 0).durability_max, 180);

  // Augments never have rank 0; gradeable ones start at 1 (or catalog min_quality).
  const itemData = require("../data/item-data.json");
  const gradeableAugment = plan.rows.filter((r) => {
    const entry = itemData.items[r.template_id];
    return entry && !entry.is_schematic && entry.is_gradeable && String(entry.category || "").startsWith("items/augment/");
  });
  assert.ok(gradeableAugment.length > 0, "expected gradeable augment rows");
  assert.ok(gradeableAugment.every((r) => Number(r.quality_level) >= 1 && Number(r.quality_level) <= 5), "augments must be ranks 1-5 only");
  const armorWeave = plan.rows.filter((r) => r.template_id === "T6_Augment_Armor1");
  assert.deepEqual(armorWeave.map((r) => r.quality_level).sort((a, b) => a - b), [3, 4, 5], "min_quality_level 3 augment seeds 3-5");

  // Console lifts any T<n>_Augment_ item below rank 1 to rank 1
  // (normalizeStandaloneAugmentQuality), so no augment may seed at rank 0 —
  // including the ones the catalog does not mark gradeable.
  const augmentRows = plan.rows.filter((r) => /^T\d+_Augment_/i.test(r.template_id));
  assert.ok(augmentRows.length > 100, "expected augment rows");
  assert.ok(augmentRows.every((r) => Number(r.quality_level) >= 1), "no augment may seed at rank 0");
  const ungradedAugment = plan.rows.filter((r) => r.template_id === "T6_Augment_Damage2");
  assert.deepEqual(ungradedAugment.map((r) => r.quality_level), [1], "a non-gradeable augment seeds one rank-1 listing");

  // No Tier 1-5 row should carry a quality rank.
  for (const row of plan.rows) {
    if (Number(row.quality_level || 0) === 0) continue;
    const tier = Number(itemData.items[row.template_id]?.tier || 0);
    assert.ok(tier >= 6, `${row.template_id} q${row.quality_level} must not be below T6`);
  }
});

test("commodities use catalog max stacks and durability stays in 100..200", () => {
  const plan = bundledSeedPlan();
  const itemData = require("../data/item-data.json");
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
    // Default stock depth is 2; vehicle locomotion overstocks by family
    // (asserted separately below).
    if (row.listings !== 2) {
      const category = String(itemData.items[row.template_id]?.category || "");
      assert.match(
        category,
        /^items\/vehicles\/[^/]+\/locomotion$/,
        `${row.template_id} has listings=${row.listings} but is not vehicle locomotion`
      );
    }
  }
});

test("vehicle locomotion stocks deeper treads and wings by family", () => {
  // Sandbike/buggy treads and ornithopter wings wear out and are a common
  // repurchase. Stock depth is per existing template/rank (assault only has
  // Mk5/Mk6; carrier only Mk6). Unique modules under the same category path
  // (Albatross / Hummingbird / Roc) share the family's count; schematics stay
  // at 2. Sandcrawler / treadwheel locomotion stays at the default 2.
  const plan = bundledSeedPlan();
  const itemData = require("../data/item-data.json");
  const expected = {
    sandbike: 3,
    buggy: 4,
    lightornithopter: 4,
    mediumornithopter: 6,
    transportornithopter: 8
  };

  const byFamily = new Map();
  for (const row of plan.rows) {
    const entry = itemData.items[row.template_id];
    const category = String(entry?.category || "");
    const parts = category.split("/");
    if (parts.length < 4 || parts[0] !== "items" || parts[1] !== "vehicles" || parts[3] !== "locomotion") {
      continue;
    }
    const family = parts[2];
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(row);
  }

  for (const [family, count] of Object.entries(expected)) {
    const rows = byFamily.get(family) || [];
    assert.ok(rows.length > 0, `expected ${family} locomotion rows`);
    assert.ok(
      rows.every((r) => r.listings === count),
      `${family} locomotion must seed ${count} listings each (got ${[...new Set(rows.map((r) => r.listings))].join(",")})`
    );
  }

  // Explicit samples from the operator request.
  assert.equal(plan.rows.find((r) => r.template_id === "SandbikeLocomotion_3")?.listings, 3);
  assert.equal(plan.rows.find((r) => r.template_id === "BuggyLocomotion_5")?.listings, 4);
  assert.equal(plan.rows.find((r) => r.template_id === "OrnithopterLightLocomotion_4")?.listings, 4);
  assert.equal(plan.rows.find((r) => r.template_id === "OrnithopterMediumLocomotion_5")?.listings, 6);
  assert.equal(plan.rows.find((r) => r.template_id === "OrnithopterMediumLocomotion_6")?.listings, 6);
  assert.equal(plan.rows.find((r) => r.template_id === "OrnithopterTransportLocomotion_6")?.listings, 8);

  // Unique locomotion modules follow the family depth; their schematics stay at 2.
  assert.equal(plan.rows.find((r) => r.template_id === "OrnithopterLightLocomotion_Unique_Speed_6")?.listings, 4);
  assert.equal(plan.rows.find((r) => r.template_id === "OrnithopterMediumLocomotion_Unique_Strafe_6")?.listings, 6);
  assert.equal(plan.rows.find((r) => r.template_id === "OrnithopterTransportLocomotion_Unique_Speed_6")?.listings, 8);
  const albatrossSchematic = plan.rows.filter((r) => r.template_id === "OrnithopterLightLocomotion_Unique_Speed_6_Schematic");
  assert.ok(albatrossSchematic.length >= 1);
  assert.ok(albatrossSchematic.every((r) => r.listings === 2), "locomotion schematics stay at 2");

  // Sandcrawler / treadwheel stay at default; suspensors are not locomotion.
  for (const id of ["SandcrawlerLocomotion_6", "TreadwheelLocomotion_6"]) {
    const row = plan.rows.find((r) => r.template_id === id);
    assert.ok(row, `${id} must still seed`);
    assert.equal(row.listings, 2, `${id} stays at default depth`);
  }
  const suspensor = plan.rows.find((r) => /emperor.?s?\s*wings/i.test(r.display_name) || /Suspensor/i.test(r.template_id || ""));
  if (suspensor) {
    assert.equal(suspensor.listings, 2, "utility suspensors are not vehicle locomotion stock");
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

test("seed plan excludes NPC templates, unnamed items, and unreleased resources", () => {
  // The game client resolves listing labels from template_id via its string
  // table. Templates with no names-table entry render as
  // "<MISSING STRING TABLE ENTRY>"; NPC/placeholder weapons and unreleased
  // resources (Water @ 1 Solari, Corpse) must never be seeded.
  const plan = bundledSeedPlan();
  const itemData = require("../data/item-data.json");
  const localizedNames = itemData.names || {};
  const ids = plan.rows.map((r) => r.template_id);

  assert.equal(ids.some((id) => /npc/i.test(id)), false, "no NPC-shaped template may be seeded");
  for (const bad of [
    "SmugDmrParaNPC",
    "ScattergunEliteNPC",
    "SmugShotEliteNPC",
    "HarkArEliteNPC",
    "RocketLauncher_1",
    "WaterItem",
    "Corpse",
    "Mouse_Corpse"
  ]) {
    assert.equal(ids.includes(bad), false, `${bad} must not be seeded`);
    assert.ok(plan.unsafe_template_ids.includes(bad), `${bad} must be on the Drop Unsafe list`);
  }

  assert.equal(ids.some((id) => id === "WaterItem"), false);
  assert.equal(plan.rows.some((r) => /^water$/i.test(r.display_name)), false, "Water must not appear by display name either");
  assert.equal(plan.rows.some((r) => /corpse/i.test(r.display_name)), false, "Corpse listings must not appear");

  for (const row of plan.rows) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(localizedNames, row.template_id),
      `${row.template_id} must have a string-table name`
    );
    assert.ok(String(localizedNames[row.template_id] || "").trim(), `${row.template_id} name must be non-empty`);
    assert.ok(String(row.display_name || "").trim(), `${row.template_id} display_name must be non-empty`);
    assert.doesNotMatch(row.display_name, /MISSING STRING TABLE ENTRY/i);
    assert.doesNotMatch(row.display_name, /^(ph_|xx_|n\/a\b)/i);
  }

  // Real items whose display name equals the template id still have a names
  // entry and must keep seeding.
  for (const keep of ["Kindjal", "Literjon", "Plastone", "Thumper"]) {
    assert.ok(ids.includes(keep), `${keep} is a real item and must stay seeded`);
  }
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
  assert.match(sql, /rec\.quality_level, rec\.item_stats::jsonb\)/);
  assert.doesNotMatch(sql, /rec\.durability_cur, rec\.durability_max/);
  assert.doesNotMatch(sql, /rec\.quality_level, rec\.item_stats\) RETURNING/);
});
