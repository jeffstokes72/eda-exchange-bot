(function () {
  "use strict";

  const statusEl = document.getElementById("status");
  const autoStatusEl = document.getElementById("autoStatus");
  const summaryEl = document.getElementById("summary");
  const tableEl = document.getElementById("table");
  const resultEl = document.getElementById("resultOutput");
  const filterEl = document.getElementById("filter");
  const kindFilterEl = document.getElementById("kindFilter");
  const multiplierEl = document.getElementById("priceMultiplier");
  const thresholdEl = document.getElementById("buybackPercent");
  const maxBuysEl = document.getElementById("maxBuys");
  const exchangeIdEl = document.getElementById("exchangeId");
  const manualExchangeIdEl = document.getElementById("manualExchangeId");
  const clearExistingEl = document.getElementById("clearExisting");
  const autoBuybackEl = document.getElementById("autoBuyback");
  const autoBuybackIntervalEl = document.getElementById("autoBuybackInterval");
  const autoSeedEl = document.getElementById("autoSeed");
  const autoSeedIntervalEl = document.getElementById("autoSeedInterval");
  const autoCleanupEl = document.getElementById("autoCleanup");
  const autoCleanupIntervalEl = document.getElementById("autoCleanupInterval");
  const serverScheduleSectionEl = document.getElementById("serverScheduleSection");
  const serverScheduleEnabledEl = document.getElementById("serverScheduleEnabled");
  const serverIntervalMinutesEl = document.getElementById("serverIntervalMinutes");
  const serverPriceMultiplierEl = document.getElementById("serverPriceMultiplier");
  const serverBuybackPercentEl = document.getElementById("serverBuybackPercent");
  const serverMaxBuysEl = document.getElementById("serverMaxBuys");
  const serverScheduleStatusEl = document.getElementById("serverScheduleStatus");
  const buybackLogEl = document.getElementById("buybackLog");
  const buybackLogMetaEl = document.getElementById("buybackLogMeta");

  let payload = null;
  let renderedRows = [];
  let exchangesLoaded = false;
  let writeInProgress = false;
  let nextAutoRunAt = 0;
  let nextAutoSeedAt = 0;
  let nextAutoCleanupAt = 0;
  let autoRunning = false;
  let serverScheduleSupported = false;
  let serverScheduleRefreshInFlight = false;
  let serverScheduleSaveInFlight = false;
  let serverProbeInFlight = false;
  let lastExecuteResult = null;
  let buybackLogEntries = [];

  const rememberedExchangeStorageKey = "eda-exchange-bot.remembered-exchanges";
  const settingsStorageKey = "eda-exchange-bot.settings";
  const buybackLogStorageKey = "eda-exchange-bot.buyback-log";

  // Per-listing buyback sweep outcome codes shown in the Buyback Sweep Log.
  // 0x0 = bought (or eligible on a dry-run). 0x1 = ask above the seeded cap.
  const BUYBACK_RESULT_CODES = {
    0x0: { label: "success", summary: "Bought (or eligible on dry-run)" },
    0x1: { label: "price too high", summary: "Ask exceeds buyback cap (threshold % of seeded grade price)" },
    0x2: { label: "no reference price", summary: "Template not in the seed plan — there is no live market average" },
    0x3: { label: "invalid price", summary: "Non-positive item_price" },
    0x4: { label: "invalid stack", summary: "Stack size is zero or missing" },
    0x5: { label: "max buys limit", summary: "Eligible but past Max Buys Per Sweep this run" },
    0x6: { label: "skipped locked", summary: "Eligible but locked by a concurrent sweep" }
  };

  // Sentinel expiration used by EDA's market bot for seller "Take Solari"
  // payment entries. The game server's dune_exchange_expire_orders proc runs
  // every ~5 minutes and purges past-dated orders; a payment entry must never
  // expire or the seller's item is consumed with no Solari paid out.
  const PAYMENT_SENTINEL_EXPIRY = 999999999;

  // PostgreSQL BIGINT ids can exceed Number.MAX_SAFE_INTEGER (2^53 - 1), so
  // exchange ids are kept as validated decimal strings end-to-end and are
  // never converted with Number(). BigInt is used only where numeric
  // comparison or sorting is required.
  const EXCHANGE_ID_PATTERN = /^[1-9][0-9]*$/;
  const PG_BIGINT_MAX = 9223372036854775807n;

  function normalizeExchangeId(value) {
    const raw = String(value ?? "").trim();
    if (!EXCHANGE_ID_PATTERN.test(raw)) return null;
    if (BigInt(raw) > PG_BIGINT_MAX) return null;
    return raw;
  }
  function compareExchangeIds(left, right) {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function sqlLiteral(value) { return "'" + String(value ?? "").replaceAll("'", "''") + "'"; }
  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : String(value ?? "");
  }
  function clampInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) return fallback;
    return number;
  }
  function roundPrice(value) {
    const number = Math.max(1, Number(value) || 1);
    let step = 1;
    if (number >= 1000000) step = 10000;
    else if (number >= 100000) step = 1000;
    else if (number >= 10000) step = 100;
    else if (number >= 1000) step = 10;
    return Math.max(1, Math.round(number / step) * step);
  }
  function currentMultiplier() { return clampInteger(multiplierEl.value, payload?.price_multiplier || 5, 1, 100); }
  function currentThreshold() { return clampInteger(thresholdEl.value, 60, 1, 100); }
  function currentMaxBuys() { return clampInteger(maxBuysEl.value, 500, 1, 5000); }
  function currentAutoIntervalMinutes() { return clampInteger(autoBuybackIntervalEl.value, 30, 10, 1440); }
  function currentAutoSeedIntervalMinutes() { return clampInteger(autoSeedIntervalEl.value, 360, 10, 1440); }
  function currentAutoCleanupIntervalMinutes() { return clampInteger(autoCleanupIntervalEl.value, 360, 10, 1440); }

  function currentExchangeIdValue() {
    const raw = String(exchangeIdEl.value || "").trim();
    if (!raw) throw new Error("Choose an exchange before running this action.");
    const id = normalizeExchangeId(raw);
    if (!id) throw new Error("Exchange selection is invalid.");
    return id;
  }
  function currentExchangeIdSql() {
    return `v_exchange_id := ${currentExchangeIdValue()};`;
  }

  function persistSettings() {
    try {
      localStorage.setItem(settingsStorageKey, JSON.stringify({
        priceMultiplier: multiplierEl.value,
        buybackPercent: thresholdEl.value,
        maxBuys: maxBuysEl.value,
        clearExisting: clearExistingEl.checked,
        autoBuyback: autoBuybackEl.checked,
        autoBuybackInterval: autoBuybackIntervalEl.value,
        autoSeed: autoSeedEl.checked,
        autoSeedInterval: autoSeedIntervalEl.value,
        autoCleanup: autoCleanupEl.checked,
        autoCleanupInterval: autoCleanupIntervalEl.value
      }));
    } catch { /* storage unavailable; settings just aren't remembered */ }
  }
  function restoreSettings() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(settingsStorageKey) || "null"); } catch { saved = null; }
    if (!saved || typeof saved !== "object") return;
    if (saved.priceMultiplier != null) multiplierEl.value = String(saved.priceMultiplier);
    if (saved.buybackPercent != null) thresholdEl.value = String(saved.buybackPercent);
    if (saved.maxBuys != null) maxBuysEl.value = String(saved.maxBuys);
    if (typeof saved.clearExisting === "boolean") clearExistingEl.checked = saved.clearExisting;
    if (typeof saved.autoBuyback === "boolean") autoBuybackEl.checked = saved.autoBuyback;
    if (saved.autoBuybackInterval != null) autoBuybackIntervalEl.value = String(saved.autoBuybackInterval);
    if (typeof saved.autoSeed === "boolean") autoSeedEl.checked = saved.autoSeed;
    if (saved.autoSeedInterval != null) autoSeedIntervalEl.value = String(saved.autoSeedInterval);
    if (typeof saved.autoCleanup === "boolean") autoCleanupEl.checked = saved.autoCleanup;
    if (saved.autoCleanupInterval != null) autoCleanupIntervalEl.value = String(saved.autoCleanupInterval);
  }

  function rememberedExchangeIds() {
    try {
      const parsed = JSON.parse(localStorage.getItem(rememberedExchangeStorageKey) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeExchangeId).filter((id) => id !== null);
    } catch {
      return [];
    }
  }
  function saveRememberedExchangeIds(ids) {
    const normalized = Array.from(new Set(ids.map(normalizeExchangeId).filter((id) => id !== null))).sort(compareExchangeIds);
    localStorage.setItem(rememberedExchangeStorageKey, JSON.stringify(normalized));
  }
  function rememberExchangeId(id) {
    const normalizedId = normalizeExchangeId(id);
    if (!normalizedId) throw new Error("Exchange ID must be a positive whole number.");
    saveRememberedExchangeIds([...rememberedExchangeIds(), normalizedId]);
    return normalizedId;
  }

  function requestBridge(action, requestPayload = {}) {
    if (window.parent === window) {
      return Promise.reject(new Error("Open this addon inside RedBlink Dune Docker Console to use bridge-backed write actions."));
    }
    if (!window.DuneAddon || typeof window.DuneAddon.request !== "function") {
      return Promise.reject(new Error("RedBlink addon bridge helper is not available."));
    }
    return window.DuneAddon.request(action, requestPayload);
  }

  function priceForRow(row) {
    const sourceMultiplier = Math.max(1, Number(payload?.price_multiplier || 1));
    return roundPrice((Number(row.price) / sourceMultiplier) * currentMultiplier());
  }

  // Bundled plan rows re-priced to the current multiplier. Schematic grades,
  // T6 ranks, listing counts, and durability are already baked into the plan.
  function baseRowsForCurrentMultiplier() {
    if (!payload) return [];
    return (payload.rows || []).map((row) => ({ ...row, price: priceForRow(row) }));
  }

  function rowsForCurrentMultiplier() {
    return baseRowsForCurrentMultiplier();
  }

  function renderSummary(rows = rowsForCurrentMultiplier()) {
    const totals = rows.reduce((acc, row) => {
      acc.listings += Number(row.listings || 0);
      acc.unique += 1;
      acc[`${row.kind}_listings`] = (acc[`${row.kind}_listings`] || 0) + Number(row.listings || 0);
      if (row.kind === "resource") acc.resource_units += Number(row.stack_size || 0) * Number(row.listings || 0);
      return acc;
    }, { listings: 0, unique: 0, resource_units: 0 });
    const metrics = [
      ["Listings", totals.listings],
      ["Unique rows", totals.unique],
      ["Resources", totals.resource_listings || 0],
      ["Resource units", totals.resource_units],
      ["Schematics", totals.schematic_listings || 0],
      ["Equippables", totals.equippable_listings || 0],
      ["Ammunition", totals.ammunition_listings || 0],
      ["Consumables", totals.consumable_listings || 0],
      ["Multiplier", `${currentMultiplier()}x`],
    ];
    summaryEl.innerHTML = metrics.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(formatNumber(value))}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  }

  function renderKinds(rows) {
    const current = kindFilterEl.value;
    const kinds = Array.from(new Set(rows.map(row => row.kind))).sort();
    kindFilterEl.innerHTML = `<option value="">All kinds</option>${kinds.map(kind => `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`).join("")}`;
    kindFilterEl.value = kinds.includes(current) ? current : "";
  }

  function visibleRows() {
    const query = filterEl.value.trim().toLowerCase();
    const kind = kindFilterEl.value;
    return renderedRows.filter(row => {
      if (kind && row.kind !== kind) return false;
      if (!query) return true;
      return [row.template_id, row.display_name, row.kind, row.category_mask, row.category_depth, row.price, row.stack_size, row.quality_level].some(value => String(value ?? "").toLowerCase().includes(query));
    });
  }

  function renderRows() {
    const rows = visibleRows();
    if (!rows.length) { tableEl.innerHTML = "<p>No seed rows match the current filter.</p>"; return; }
    const shown = rows.slice(0, 250);
    tableEl.innerHTML = `<table><thead><tr><th>Name</th><th>Template</th><th>Kind</th><th>Grade</th><th>Dur</th><th>Listings</th><th>Stack</th><th>Price</th><th>Mask</th><th>Depth</th></tr></thead><tbody>${shown.map(row => `<tr><td>${escapeHtml(row.display_name)}</td><td>${escapeHtml(row.template_id)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(formatNumber(row.quality_level || 0))}</td><td>${escapeHtml(formatNumber(row.durability_max ?? 100))}</td><td>${escapeHtml(formatNumber(row.listings))}</td><td>${escapeHtml(formatNumber(row.stack_size))}</td><td>${escapeHtml(formatNumber(row.price))}</td><td>${escapeHtml(row.category_mask)}</td><td>${escapeHtml(row.category_depth)}</td></tr>`).join("")}</tbody></table>`;
    if (rows.length > shown.length) tableEl.insertAdjacentHTML("beforeend", `<p>Showing first ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} matching unique rows. Narrow the filter for more detail.</p>`);
  }

  function renderExchangeOptions(rows, preferredId = exchangeIdEl.value) {
    const discovered = (rows || [])
      .map((row) => ({
        // exchange_id arrives as text from SQL and must stay a string: BIGINT
        // ids above Number.MAX_SAFE_INTEGER lose precision through Number().
        id: normalizeExchangeId(row.exchange_id),
        orderCount: Number(row.order_count || 0),
        botOrders: Number(row.bot_order_count || 0),
        npcFlagOrders: Number(row.npc_flag_order_count || 0),
        playerOrders: Number(row.player_order_count || 0),
        accessPoints: Number(row.access_point_count || 0),
        isGlobal: Boolean(row.is_global),
        source: "live"
      }))
      .filter((row) => row.id !== null);

    saveRememberedExchangeIds([...rememberedExchangeIds(), ...discovered.map((exchange) => exchange.id)]);

    const byId = new Map(discovered.map((exchange) => [exchange.id, exchange]));
    for (const id of rememberedExchangeIds()) {
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          orderCount: 0,
          botOrders: 0,
          npcFlagOrders: 0,
          playerOrders: 0,
          accessPoints: 0,
          isGlobal: false,
          source: "remembered"
        });
      }
    }

    // Exchanges with real access points come first: those are the exchanges
    // players actually reach in-game (EDA market bot exchange-detection fix).
    const options = Array.from(byId.values())
      .sort((left, right) => {
        const leftHasAp = left.accessPoints > 0 ? 0 : 1;
        const rightHasAp = right.accessPoints > 0 ? 0 : 1;
        if (leftHasAp !== rightHasAp) return leftHasAp - rightHasAp;
        if (left.isGlobal !== right.isGlobal) return left.isGlobal ? 1 : -1;
        return compareExchangeIds(left.id, right.id);
      });

    if (!options.length) {
      exchangeIdEl.innerHTML = `<option value="">No exchanges found</option>`;
      exchangesLoaded = false;
      return;
    }

    exchangeIdEl.innerHTML = options.map((exchange) => {
      const labelParts = [
        exchange.isGlobal ? "Global" : `Exchange ${exchange.id}`,
        `ID ${exchange.id}`,
        `${exchange.accessPoints.toLocaleString()} access points`,
        `${exchange.orderCount.toLocaleString()} orders`,
        `${exchange.botOrders.toLocaleString()} bot`,
        `${exchange.playerOrders.toLocaleString()} player`,
        exchange.source === "remembered" ? "remembered/manual" : "live"
      ];
      return `<option value="${exchange.id}">${escapeHtml(labelParts.join(" | "))}</option>`;
    }).join("");
    const preferred = options.find((exchange) => String(exchange.id) === String(preferredId || ""));
    const withAccessPoint = options.find((exchange) => exchange.accessPoints > 0 && !exchange.isGlobal);
    const nonGlobal = options.find((exchange) => !exchange.isGlobal);
    const global = options.find((exchange) => exchange.isGlobal);
    exchangeIdEl.value = String((preferred || withAccessPoint || nonGlobal || global || options[0]).id);
    exchangesLoaded = true;
  }

  async function loadExchanges() {
    exchangeIdEl.innerHTML = `<option value="">Loading exchanges...</option>`;
    try {
      const result = await requestBridge("database.query", {
        query: `WITH global_exchange AS (
    SELECT dune.get_dune_exchange_id('Global')::bigint AS exchange_id
),
known_exchanges AS (
    SELECT exchange_id FROM dune.dune_exchange_orders
    UNION
    SELECT exchange_id FROM dune.dune_exchange_accesspoints
    UNION
    SELECT exchange_id FROM global_exchange
)
SELECT
    k.exchange_id::text AS exchange_id,
    (k.exchange_id = (SELECT exchange_id FROM global_exchange)) AS is_global,
    ap.access_point_count::text AS access_point_count,
    COUNT(o.id)::text AS order_count,
    COUNT(o.id) FILTER (WHERE o.owner_id = bot.owner_id OR o.is_npc_order = TRUE)::text AS bot_order_count,
    COUNT(o.id) FILTER (WHERE o.is_npc_order = TRUE)::text AS npc_flag_order_count,
    COUNT(o.id) FILTER (WHERE COALESCE(o.is_npc_order, FALSE) = FALSE AND (bot.owner_id IS NULL OR o.owner_id <> bot.owner_id))::text AS player_order_count
FROM known_exchanges k
LEFT JOIN dune.dune_exchange_orders o ON o.exchange_id = k.exchange_id
LEFT JOIN LATERAL (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
) bot ON TRUE
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS access_point_count FROM dune.dune_exchange_accesspoints a WHERE a.exchange_id = k.exchange_id
) ap ON TRUE
GROUP BY k.exchange_id, ap.access_point_count
ORDER BY is_global ASC, k.exchange_id ASC;`
      });
      renderExchangeOptions(result.rows || []);
    } catch (error) {
      exchangeIdEl.innerHTML = `<option value="">Exchange lookup failed</option>`;
      exchangesLoaded = false;
      statusEl.className = "status error";
      statusEl.textContent = `Exchange lookup failed: ${error.message || String(error)}`;
    }
  }

  function addManualExchange() {
    try {
      const id = rememberExchangeId(manualExchangeIdEl.value);
      manualExchangeIdEl.value = "";
      renderExchangeOptions([], id);
      statusEl.className = "status ok";
      statusEl.textContent = `Remembered exchange ID ${id}. It can now be selected even with no current orders.`;
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
    }
  }

  function refreshPreview() {
    if (!payload) return;
    renderedRows = rowsForCurrentMultiplier();
    renderSummary(renderedRows);
    renderKinds(renderedRows);
    renderRows();
    statusEl.className = "status";
    statusEl.textContent = `Preview ready from EDA ${payload.panel_version}; ${renderedRows.length.toLocaleString()} unique rows at ${currentMultiplier()}x.`;
  }

  function clampDurability(value, fallback = 100) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(100, Math.min(200, number));
  }

  // Absolute durability lives on dune.items.stats (FItemStackAndDurabilityStats),
  // matching RedBlink/EDA item grants. Exchange order durability_* stays at the
  // normalized wear fraction 1.0/1.0 (full condition).
  function itemStatsJson(row) {
    const durMax = clampDurability(row.durability_max ?? row.durability_cur ?? 100);
    const durCur = Math.min(clampDurability(row.durability_cur ?? durMax, durMax), durMax);
    return JSON.stringify({
      FItemStackAndDurabilityStats: [[], {
        CurrentDurability: durCur,
        MaxDurability: durMax,
        DecayedMaxDurability: durMax
      }]
    });
  }

  function valuesForSeedRows(rows) {
    return rows.map((row) => `(${[
      sqlLiteral(row.template_id),
      Number(row.stack_size),
      Number(row.price),
      Number(row.category_mask),
      Number(row.category_depth),
      Number(row.quality_level || 0),
      sqlLiteral(row.kind),
      Number(row.listings || 1),
      sqlLiteral(itemStatsJson(row))
    ].join(",")})`).join(",\n");
  }

  // forceClear is used by the unattended reseed: repeating a full seed on a
  // timer without clearing first would stack another ~6k bot listings onto the
  // exchange every interval.
  function buildSeedSql({ forceClear = false } = {}) {
    const rows = rowsForCurrentMultiplier();
    const valuesSql = valuesForSeedRows(rows);
    const exchangeSql = currentExchangeIdSql();
    // Pre-seed cleanup is scoped to the selected exchange: without the
    // exchange_id condition, reseeding one exchange would delete the bot's
    // listings from every other seeded exchange.
    const clearSql = (forceClear || clearExistingEl.checked) ? `
DO $$
DECLARE
    v_owner_id BIGINT;
    v_exchange_id BIGINT;
    v_item_ids BIGINT[];
BEGIN
    ${exchangeSql}
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NOT NULL THEN
        SELECT ARRAY_AGG(item_id) INTO v_item_ids
        FROM dune.dune_exchange_orders
        WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id AND item_id IS NOT NULL;
        DELETE FROM dune.dune_exchange_sell_orders WHERE order_id IN (SELECT id FROM dune.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id);
        DELETE FROM dune.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id;
        IF v_item_ids IS NOT NULL THEN DELETE FROM dune.items WHERE id = ANY(v_item_ids); END IF;
    END IF;
END $$;` : "";
    return `BEGIN;
CREATE TEMP TABLE market_seed_plan (template_id TEXT NOT NULL, stack_size BIGINT NOT NULL, item_price BIGINT NOT NULL, category_mask INTEGER NOT NULL, category_depth SMALLINT NOT NULL, quality_level BIGINT NOT NULL, seed_kind TEXT NOT NULL, listing_count INTEGER NOT NULL, item_stats TEXT NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_seed_result (status TEXT NOT NULL, exchange_id BIGINT NOT NULL, access_point_id BIGINT NOT NULL, owner_id BIGINT NOT NULL, inventory_id BIGINT NOT NULL) ON COMMIT DROP;
INSERT INTO market_seed_plan (template_id, stack_size, item_price, category_mask, category_depth, quality_level, seed_kind, listing_count, item_stats) VALUES
${valuesSql || "(NULL,1,0,0,0,0,'equippable',0,'{}')"};
DELETE FROM market_seed_plan WHERE template_id IS NULL;
${clearSql}
DO $$
DECLARE
    v_exchange_id BIGINT; v_access_point_id BIGINT; v_inventory_id BIGINT; v_owner_id BIGINT; v_user_id BIGINT; v_partition_id BIGINT; v_next_position BIGINT; v_expiration_time BIGINT; v_balance BIGINT; v_item_id BIGINT; v_order_id BIGINT; rec RECORD; idx INTEGER;
BEGIN
    ${exchangeSql}
    -- Resolve the access point from the accesspoints table first (authoritative:
    -- it is what the game client uses). Fall back to an existing order only if
    -- the table has no row, and never fabricate an id: that violates the FK and
    -- produces listings players cannot see (EDA market bot access-point fix).
    SELECT COALESCE(
        (SELECT id FROM dune.dune_exchange_accesspoints WHERE exchange_id = v_exchange_id ORDER BY id LIMIT 1),
        (SELECT access_point_id FROM dune.dune_exchange_orders WHERE exchange_id = v_exchange_id LIMIT 1)
    ) INTO v_access_point_id;
    IF v_access_point_id IS NULL THEN
        RAISE EXCEPTION 'Exchange % has no access point yet. The game creates one when a player first opens an exchange terminal; seed after that happens.', v_exchange_id;
    END IF;
    SELECT dune.get_exchange_inventory_id(v_exchange_id) INTO v_inventory_id;
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NULL THEN
        SELECT partition_id INTO v_partition_id FROM dune.world_partition ORDER BY partition_id LIMIT 1;
        INSERT INTO dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id) VALUES ('Revy', 0, '{}', '{}', 0, v_partition_id) RETURNING id INTO v_owner_id;
    END IF;
    SELECT dune.dune_exchange_get_user_id(v_owner_id) INTO v_user_id;
    -- Top the bot balance up to 9T only when it dips below the 1T floor,
    -- matching the EDA market bot's balance seeding behavior.
    SELECT COALESCE(dune.dune_exchange_retrieve_solari_balance(v_owner_id), 0) INTO v_balance;
    IF v_balance < 1000000000000 THEN
        PERFORM dune.dune_exchange_modify_user_solari_balance(v_owner_id, 9000000000000 - v_balance);
    END IF;
    INSERT INTO dune.dune_exchange_categories_hash (id, hash) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET hash = 0;
    SELECT COALESCE(MAX(position_index), -1) + 1 INTO v_next_position FROM dune.items WHERE inventory_id = v_inventory_id;
    -- Derive listing expiry from the newest non-sentinel order so sentinel
    -- payment entries (999999999) cannot inflate it past the sentinel.
    SELECT LEAST(COALESCE(MAX(expiration_time) + 604800, ${PAYMENT_SENTINEL_EXPIRY}), ${PAYMENT_SENTINEL_EXPIRY}) INTO v_expiration_time
    FROM dune.dune_exchange_orders WHERE expiration_time < ${PAYMENT_SENTINEL_EXPIRY};
    FOR rec IN SELECT * FROM market_seed_plan ORDER BY seed_kind, template_id, quality_level LOOP
        FOR idx IN 1..GREATEST(1, rec.listing_count) LOOP
            INSERT INTO dune.items (inventory_id, stack_size, position_index, template_id, quality_level, stats) VALUES (v_inventory_id, rec.stack_size, v_next_position, rec.template_id, rec.quality_level, rec.item_stats::jsonb) RETURNING id INTO v_item_id;
            v_next_position := v_next_position + 1;
            INSERT INTO dune.dune_exchange_orders (exchange_id, access_point_id, owner_id, is_npc_order, expiration_time, template_id, durability_cur, durability_max, category_mask, category_depth, item_price, quality_level, item_id) VALUES (v_exchange_id, v_access_point_id, v_owner_id, TRUE, v_expiration_time, rec.template_id, 1.0, 1.0, rec.category_mask, rec.category_depth, rec.item_price, rec.quality_level, v_item_id) RETURNING id INTO v_order_id;
            INSERT INTO dune.dune_exchange_sell_orders (order_id, initial_stack_size, wear_normalized_price) VALUES (v_order_id, rec.stack_size, rec.item_price);
        END LOOP;
    END LOOP;
    INSERT INTO market_seed_result (status, exchange_id, access_point_id, owner_id, inventory_id) VALUES ('seeded', v_exchange_id, v_access_point_id, v_owner_id, v_inventory_id);
END $$;
SELECT r.status, r.exchange_id, r.access_point_id, r.owner_id, r.inventory_id, SUM(listing_count) AS listing_count, SUM(listing_count) FILTER (WHERE seed_kind = 'equippable') AS equippable_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'schematic') AS schematic_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'resource') AS resource_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'ammunition') AS ammunition_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'consumable') AS consumable_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'utility') AS utility_listings, SUM(listing_count) FILTER (WHERE seed_kind = 'cartography') AS cartography_listings, SUM(CASE WHEN seed_kind = 'resource' THEN stack_size * listing_count ELSE 0 END) AS resource_units, ${currentMultiplier()} AS price_multiplier FROM market_seed_plan CROSS JOIN market_seed_result r GROUP BY r.status, r.exchange_id, r.access_point_id, r.owner_id, r.inventory_id;
COMMIT;`;
  }

  // Order grade used for buyback plan matching. dune_exchange_orders
  // .quality_level is NOT NULL DEFAULT 0, so a COALESCE chain would never reach
  // the backing item and a listing whose rank only landed on dune.items would
  // be priced as rank 0. Rank 0 means "no rank", so the higher of the two is
  // the listing's real grade. Player posts never enter the reference price —
  // caps come only from the seeded plan row at this grade.
  const BUYBACK_ORDER_GRADE_SQL = "LEAST(GREATEST(COALESCE(o.quality_level, 0), COALESCE(i.quality_level, 0), 0), 5)";

  // Full stack quantity for a sell listing. Player resource listings sometimes
  // keep the real quantity on sell_orders.initial_stack_size while
  // items.stack_size stays 1; COALESCE alone would then pay for one unit and
  // delete the rest unpaid. We always remove the whole listing, so take the
  // larger of the two positive counts.
  const BUYBACK_STACK_SQL = "GREATEST(COALESCE(i.stack_size, 0), COALESCE(s.initial_stack_size, 0))";

  // Buyback eligibility shared by the write sweep, diagnostics, and the
  // read-only probe: never buy non-positive prices or empty stacks (a negative
  // player listing would otherwise match <= cap and credit the bot). Cap is
  // already threshold% of the seeded price at this exact grade, so no further
  // grade multiplier is applied in SQL.
  const BUYBACK_ELIGIBLE_PREDICATE = `o.item_price > 0 AND ${BUYBACK_STACK_SQL} > 0 AND o.item_price <= p.max_unit_price`;

  // Plan lookup for one listing: the cap for its own grade when the plan seeds
  // that grade, otherwise the closest seeded grade. Matching the grade exactly
  // and nothing else would make whole classes of listing unbuyable, because the
  // plan deliberately does not seed every grade of every template (tools and
  // Tier 1-5 are stock-only, augments start at rank 1 or their catalog
  // minimum). Preferring the nearest seeded grade *below* the listing keeps the
  // fallback conservative: an unseeded high grade is capped by a cheaper
  // reference, never a more expensive one. Only a listing below every seeded
  // grade falls upward, to the cheapest row the template has.
  const BUYBACK_PLAN_LATERAL = `LEFT JOIN LATERAL (
        SELECT pp.template_id, pp.quality_level, pp.max_unit_price
        FROM market_buy_plan pp
        WHERE pp.template_id = o.template_id
        ORDER BY (pp.quality_level <= ${BUYBACK_ORDER_GRADE_SQL}) DESC,
                 CASE WHEN pp.quality_level <= ${BUYBACK_ORDER_GRADE_SQL} THEN -pp.quality_level ELSE pp.quality_level END
        LIMIT 1
    ) p ON TRUE`;

  // Classifies every player sell listing on the selected exchange. Shared by
  // the write-sweep log table and the read-only dry-run log query.
  const BUYBACK_RESULT_CODE_SQL = `CASE
        WHEN p.template_id IS NULL THEN 2
        WHEN o.item_price <= 0 THEN 3
        WHEN ${BUYBACK_STACK_SQL} <= 0 THEN 4
        WHEN o.item_price > p.max_unit_price THEN 1
        ELSE 0
    END`;
  const BUYBACK_RESULT_LABEL_SQL = `CASE
        WHEN p.template_id IS NULL THEN 'no reference price'
        WHEN o.item_price <= 0 THEN 'invalid price'
        WHEN ${BUYBACK_STACK_SQL} <= 0 THEN 'invalid stack'
        WHEN o.item_price > p.max_unit_price THEN 'price too high'
        ELSE 'eligible'
    END`;
  const BUYBACK_RESULT_DETAIL_SQL = `CASE
        WHEN p.template_id IS NULL THEN 'template not in seed plan (no live market average; caps come only from seeded NPC prices)'
        WHEN o.item_price <= 0 THEN 'item_price must be > 0'
        WHEN ${BUYBACK_STACK_SQL} <= 0 THEN 'stack size must be > 0'
        WHEN o.item_price > p.max_unit_price THEN 'ask ' || o.item_price::text || ' > cap ' || p.max_unit_price::text
        ELSE 'ask ' || o.item_price::text || ' <= cap ' || p.max_unit_price::text || '; full stack ' || (${BUYBACK_STACK_SQL})::text
    END`;

  // Buyback plan: one cap per (template_id, quality_level) = threshold% of that
  // seeded row's price. Seeded grade prices are not always q0 × grade_mult
  // after stepped rounding, so deriving caps from a grade-0 base and
  // re-applying multipliers in SQL undershoots (or overshoots) true 60% of the
  // seeded market at that grade. Player listings never affect these caps.
  function buybackPlanValuesSql() {
    const rows = baseRowsForCurrentMultiplier();
    const threshold = currentThreshold();
    const maxPrice = new Map();
    for (const row of rows) {
      const templateId = String(row.template_id || "");
      if (!templateId) continue;
      const grade = clampInteger(row.quality_level, 0, 0, 5);
      const price = Math.max(1, Math.round(Number(row.price)) || 0);
      const key = `${templateId}\0${grade}`;
      maxPrice.set(key, Math.max(maxPrice.get(key) || 0, price));
    }
    return Array.from(maxPrice.entries())
      .map(([key, price]) => {
        const sep = key.indexOf("\0");
        return {
          templateId: key.slice(0, sep),
          grade: Number(key.slice(sep + 1)),
          cap: Math.max(1, Math.floor((price * threshold + 99) / 100))
        };
      })
      .sort((a, b) => a.templateId.localeCompare(b.templateId) || a.grade - b.grade)
      .map((entry) => `(${sqlLiteral(entry.templateId)},${entry.grade},${entry.cap})`)
      .join(",\n");
  }

  function buybackPlanValuesOrNullSql() {
    return buybackPlanValuesSql() || "(NULL::text,NULL::bigint,NULL::bigint)";
  }

  function buildBuybackSql() {
    const exchangeId = currentExchangeIdValue();
    const threshold = currentThreshold();
    const maxBuys = currentMaxBuys();
    const valuesSql = buybackPlanValuesSql();
    const planInsert = valuesSql
      ? `INSERT INTO market_buy_plan (template_id, quality_level, max_unit_price) VALUES\n${valuesSql};`
      : `-- buyback plan empty: no seeded caps; every player listing logs as 0x2\n`;
    return `BEGIN;
CREATE TEMP TABLE market_buy_plan (template_id TEXT NOT NULL, quality_level BIGINT NOT NULL, max_unit_price BIGINT NOT NULL, PRIMARY KEY (template_id, quality_level)) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_result (purchased INTEGER NOT NULL, total_units BIGINT NOT NULL, total_solari BIGINT NOT NULL, threshold_percent INTEGER NOT NULL, max_buys INTEGER NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_diagnostics (player_sell_orders BIGINT NOT NULL, known_player_sell_orders BIGINT NOT NULL, eligible_player_sell_orders BIGINT NOT NULL, above_threshold_sell_orders BIGINT NOT NULL, unknown_template_sell_orders BIGINT NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_log (order_id BIGINT NOT NULL, template_id TEXT NOT NULL, quality_level BIGINT NOT NULL, item_price BIGINT NOT NULL, stack_size BIGINT NOT NULL, max_unit_price BIGINT, result_code INTEGER NOT NULL, result_label TEXT NOT NULL, detail TEXT NOT NULL) ON COMMIT DROP;
${planInsert}
DO $$
DECLARE
    v_owner_id BIGINT; v_partition_id BIGINT; v_log_order_id BIGINT; v_balance BIGINT; v_purchased INTEGER := 0; v_units BIGINT := 0; v_solari BIGINT := 0; rec RECORD;
BEGIN
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NULL THEN
        SELECT partition_id INTO v_partition_id FROM dune.world_partition ORDER BY partition_id LIMIT 1;
        INSERT INTO dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id) VALUES ('Revy', 0, '{}', '{}', 0, v_partition_id) RETURNING id INTO v_owner_id;
    END IF;
    -- No dune_exchange_get_user_id call here: its INSERT .. ON CONFLICT would
    -- wait on another sweep's uncommitted balance update, serializing sweeps
    -- that SKIP LOCKED lets run side by side. The top-up below creates the
    -- users row itself when it is missing (balance coalesces to 0 < floor).
    SELECT COALESCE(dune.dune_exchange_retrieve_solari_balance(v_owner_id), 0) INTO v_balance;
    IF v_balance < 1000000000000 THEN
        PERFORM dune.dune_exchange_modify_user_solari_balance(v_owner_id, 9000000000000 - v_balance);
    END IF;
    INSERT INTO market_buy_log (order_id, template_id, quality_level, item_price, stack_size, max_unit_price, result_code, result_label, detail)
    SELECT o.id, o.template_id, ${BUYBACK_ORDER_GRADE_SQL}, o.item_price, ${BUYBACK_STACK_SQL}, p.max_unit_price, ${BUYBACK_RESULT_CODE_SQL}, ${BUYBACK_RESULT_LABEL_SQL}, ${BUYBACK_RESULT_DETAIL_SQL}
    FROM dune.dune_exchange_orders o
    JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
    LEFT JOIN dune.items i ON i.id = o.item_id
    ${BUYBACK_PLAN_LATERAL}
    WHERE o.exchange_id = ${exchangeId} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id;
    INSERT INTO market_buy_diagnostics SELECT COUNT(*), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND ${BUYBACK_ELIGIBLE_PREDICATE}), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND o.item_price > 0 AND ${BUYBACK_STACK_SQL} > 0 AND o.item_price > p.max_unit_price), COUNT(*) FILTER (WHERE p.template_id IS NULL) FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id LEFT JOIN dune.items i ON i.id = o.item_id ${BUYBACK_PLAN_LATERAL} WHERE o.exchange_id = ${exchangeId} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id;
    -- FOR UPDATE OF o, s SKIP LOCKED is the database-level concurrency guard:
    -- the page-level writeInProgress flag only covers one browser tab, so two
    -- tabs/admins sweeping at once could otherwise buy the same order twice
    -- (duplicate seller payment, double bot debit). Locking the selected order
    -- rows makes concurrent sweeps skip anything already claimed, and rows
    -- deleted by a committed sweep drop out of the re-checked result.
    FOR rec IN SELECT o.id AS order_id, o.exchange_id, o.access_point_id, o.owner_id AS seller_actor_id, o.template_id, o.item_price, o.item_id, ${BUYBACK_STACK_SQL} AS actual_stack, p.max_unit_price FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id LEFT JOIN dune.items i ON i.id = o.item_id ${BUYBACK_PLAN_LATERAL} WHERE o.exchange_id = ${exchangeId} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id AND ${BUYBACK_ELIGIBLE_PREDICATE} ORDER BY o.item_price ASC, o.id ASC LIMIT ${maxBuys} FOR UPDATE OF o, s SKIP LOCKED LOOP
        -- Seller "Take Solari" payment entry. item_price stays the per-unit
        -- price (the game multiplies by stack_size itself) and expiration is
        -- the never-expires sentinel so the game server's expire proc cannot
        -- purge an uncollected payment (EDA "items eaten without payment" fix).
        -- actual_stack is the full listed quantity (see BUYBACK_STACK_SQL), so
        -- a 500-unit resource listing is bought and paid in one sweep — never
        -- a single unit from the stack.
        INSERT INTO dune.dune_exchange_orders (exchange_id, access_point_id, owner_id, template_id, expiration_time, durability_cur, durability_max, item_price, category_mask, category_depth, is_npc_order) VALUES (rec.exchange_id, rec.access_point_id, rec.seller_actor_id, rec.template_id, ${PAYMENT_SENTINEL_EXPIRY}, 1.0, 1.0, rec.item_price, 0, 0, FALSE) RETURNING id INTO v_log_order_id;
        INSERT INTO dune.dune_exchange_fulfilled_orders (order_id, source_order_id, completion_type, stack_size, original_order_id) VALUES (v_log_order_id, NULL, 4, rec.actual_stack, rec.order_id);
        UPDATE dune.dune_exchange_users SET solari_balance = solari_balance - (rec.item_price * rec.actual_stack) WHERE owner_id = v_owner_id;
        DELETE FROM dune.dune_exchange_sell_orders WHERE order_id = rec.order_id;
        DELETE FROM dune.dune_exchange_orders WHERE id = rec.order_id;
        IF rec.item_id IS NOT NULL THEN DELETE FROM dune.items WHERE id = rec.item_id; END IF;
        UPDATE market_buy_log SET result_code = 0, result_label = 'success', detail = 'bought stack ' || rec.actual_stack::text || ' at ' || rec.item_price::text || '/unit (cap ' || rec.max_unit_price::text || ')' WHERE order_id = rec.order_id;
        v_purchased := v_purchased + 1; v_units := v_units + rec.actual_stack; v_solari := v_solari + (rec.item_price * rec.actual_stack);
    END LOOP;
    -- Eligible rows still marked eligible were not bought: either Max Buys
    -- truncated the loop, or SKIP LOCKED lost the race to another sweep.
    IF v_purchased >= ${maxBuys} THEN
        UPDATE market_buy_log SET result_code = 5, result_label = 'max buys limit', detail = 'eligible but past Max Buys Per Sweep (' || ${maxBuys}::text || ')' WHERE result_code = 0 AND result_label = 'eligible';
    ELSE
        UPDATE market_buy_log SET result_code = 6, result_label = 'skipped locked', detail = 'eligible but locked by a concurrent sweep' WHERE result_code = 0 AND result_label = 'eligible';
    END IF;
    INSERT INTO market_buy_result (purchased, total_units, total_solari, threshold_percent, max_buys) VALUES (v_purchased, v_units, v_solari, ${threshold}, ${maxBuys});
END $$;
SELECT json_build_object(
    'result', (SELECT row_to_json(r) FROM market_buy_result r),
    'diagnostics', (SELECT row_to_json(d) FROM market_buy_diagnostics d),
    'log', (SELECT COALESCE(json_agg(l ORDER BY l.result_code ASC, l.item_price ASC, l.order_id ASC), '[]'::json) FROM market_buy_log l)
)::text AS buyback_report;
COMMIT;`;
  }

  // Read-only eligibility probe used by auto buyback. This runs through
  // database.query (no backup is taken), so idle auto ticks are cheap on
  // self-hosted infrastructure; the write sweep only runs when this finds
  // at least one player listing at or below the threshold.
  function buildBuybackEligibilitySql() {
    const exchangeId = currentExchangeIdValue();
    const valuesSql = buybackPlanValuesSql();
    if (!valuesSql) {
      return `SELECT '0' AS eligible_orders;`;
    }
    return `WITH market_buy_plan(template_id, quality_level, max_unit_price) AS (
    VALUES
${valuesSql}
),
bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
)
SELECT COUNT(*)::text AS eligible_orders
FROM dune.dune_exchange_orders o
JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
LEFT JOIN dune.items i ON i.id = o.item_id
${BUYBACK_PLAN_LATERAL}
LEFT JOIN bot b ON TRUE
WHERE o.exchange_id = ${exchangeId}
  AND o.is_npc_order = FALSE
  AND (b.owner_id IS NULL OR o.owner_id <> b.owner_id)
  AND ${BUYBACK_ELIGIBLE_PREDICATE};`;
  }

  // Read-only per-listing classification for the Buyback Sweep Log dry-run.
  // Caps come only from the seeded plan — there is no live market average.
  function buildBuybackClassifySql() {
    const exchangeId = currentExchangeIdValue();
    const valuesSql = buybackPlanValuesOrNullSql();
    return `WITH market_buy_plan(template_id, quality_level, max_unit_price) AS (
    VALUES
${valuesSql}
),
bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
)
SELECT
    o.id::text AS order_id,
    o.template_id,
    (${BUYBACK_ORDER_GRADE_SQL})::text AS quality_level,
    o.item_price::text AS item_price,
    (${BUYBACK_STACK_SQL})::text AS stack_size,
    COALESCE(p.max_unit_price, 0)::text AS max_unit_price,
    (${BUYBACK_RESULT_CODE_SQL})::text AS result_code,
    ${BUYBACK_RESULT_LABEL_SQL} AS result_label,
    ${BUYBACK_RESULT_DETAIL_SQL} AS detail
FROM dune.dune_exchange_orders o
JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
LEFT JOIN dune.items i ON i.id = o.item_id
${BUYBACK_PLAN_LATERAL}
LEFT JOIN bot b ON TRUE
WHERE o.exchange_id = ${exchangeId}
  AND o.is_npc_order = FALSE
  AND (b.owner_id IS NULL OR o.owner_id <> b.owner_id)
ORDER BY (${BUYBACK_RESULT_CODE_SQL}) ASC, o.item_price ASC, o.id ASC;`;
  }

  function buildClearNpcSql() {
    return `BEGIN;
WITH bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
),
target_orders AS MATERIALIZED (
    SELECT o.id, o.item_id
    FROM dune.dune_exchange_orders o
    JOIN bot b ON b.owner_id = o.owner_id
),
deleted_sell_orders AS (
    DELETE FROM dune.dune_exchange_sell_orders s
    USING target_orders t
    WHERE s.order_id = t.id
    RETURNING s.order_id
),
deleted_orders AS (
    DELETE FROM dune.dune_exchange_orders o
    USING target_orders t
    WHERE o.id = t.id
    RETURNING o.id, o.item_id
),
deleted_items AS (
    DELETE FROM dune.items i
    USING deleted_orders d
    WHERE d.item_id IS NOT NULL AND i.id = d.item_id
    RETURNING i.id
)
SELECT
    COALESCE((SELECT owner_id::text FROM bot), 'missing') AS bot_actor_id,
    (SELECT COUNT(*) FROM target_orders)::text AS npc_orders_found,
    (SELECT COUNT(*) FROM deleted_sell_orders)::text AS sell_orders_deleted,
    (SELECT COUNT(*) FROM deleted_orders)::text AS exchange_orders_deleted,
    (SELECT COUNT(*) FROM deleted_items)::text AS backing_items_deleted;
COMMIT;`;
  }

  function buildDropUnsafeSql() {
    const unsafeIds = Array.isArray(payload?.unsafe_template_ids) ? payload.unsafe_template_ids : [];
    if (!unsafeIds.length) return "SELECT 'No unsafe market template ids were bundled in this EDA seed plan.' AS status;";
    const valuesSql = unsafeIds.map((templateId) => `(${sqlLiteral(templateId)})`).join(",\n");
    return `BEGIN;
WITH unsafe_market_templates(template_id) AS (
    VALUES
${valuesSql}
),
target_orders AS MATERIALIZED (
    SELECT o.id, o.item_id, o.template_id
    FROM dune.dune_exchange_orders o
    JOIN unsafe_market_templates u ON u.template_id = o.template_id
    LEFT JOIN dune.actors a ON a.id = o.owner_id
    WHERE o.is_npc_order = TRUE OR a.class = 'Revy'
),
deleted_sell_orders AS (
    DELETE FROM dune.dune_exchange_sell_orders s
    USING target_orders t
    WHERE s.order_id = t.id
    RETURNING s.order_id
),
deleted_orders AS (
    DELETE FROM dune.dune_exchange_orders o
    USING target_orders t
    WHERE o.id = t.id
    RETURNING o.id, o.item_id, o.template_id
),
deleted_items AS (
    DELETE FROM dune.items i
    USING deleted_orders d
    WHERE d.item_id IS NOT NULL AND i.id = d.item_id
    RETURNING i.id
)
SELECT
    (SELECT COUNT(*) FROM unsafe_market_templates)::text AS unsafe_template_count,
    (SELECT COUNT(*) FROM target_orders)::text AS npc_orders_found,
    (SELECT COUNT(*) FROM deleted_sell_orders)::text AS sell_orders_deleted,
    (SELECT COUNT(*) FROM deleted_orders)::text AS exchange_orders_deleted,
    (SELECT COUNT(*) FROM deleted_items)::text AS backing_items_deleted;
COMMIT;`;
  }

  async function executeWrite(label, sql, options = {}) {
    if (writeInProgress) {
      statusEl.className = "status error";
      statusEl.textContent = "Another write is already in progress.";
      return false;
    }
    const confirmPrompt = options.confirmPrompt !== false;
    if (!exchangesLoaded && ["Seed NPC sell market"].includes(label)) {
      statusEl.className = "status error";
      statusEl.textContent = "Exchange list is not loaded yet. Refresh exchanges before seeding.";
      return false;
    }
    const confirmDetail = options.confirmDetail ? ` ${options.confirmDetail}` : "";
    if (confirmPrompt && !confirm(`${label}?${confirmDetail} RedBlink will create a database backup before this write. This may take some time.`)) return false;
    statusEl.className = "status";
    statusEl.textContent = `${label} starting. RedBlink is creating a backup before the database write...`;
    resultEl.textContent = "Running...";
    writeInProgress = true;
    lastExecuteResult = null;
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    try {
      const result = await requestBridge("database.execute", { query: sql });
      lastExecuteResult = result;
      statusEl.className = "status ok";
      statusEl.textContent = `${label} complete.`;
      resultEl.textContent = JSON.stringify(result, null, 2);
      try { rememberExchangeId(exchangeIdEl.value); } catch { /* nothing selected */ }
      if (label === "Seed NPC sell market" || label === "Clear EDA NPC listings" || label === "Drop unsafe NPC listings") {
        await loadExchanges();
      }
      return true;
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
      resultEl.textContent = error.stack || error.message || String(error);
      return false;
    } finally {
      writeInProgress = false;
      for (const button of document.querySelectorAll("button")) button.disabled = false;
    }
  }

  function runWrite(label, sqlBuilder, options = {}) {
    try {
      return executeWrite(label, sqlBuilder(), options);
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
      resultEl.textContent = error.stack || error.message || String(error);
      return Promise.resolve(false);
    }
  }

  function buybackCodeHex(code) {
    const number = Number(code);
    if (!Number.isFinite(number) || number < 0) return "0x?";
    return `0x${number.toString(16).toUpperCase()}`;
  }

  function normalizeBuybackLogRow(row, overrides = {}) {
    if (!row || typeof row !== "object") return null;
    const code = Number(row.result_code);
    const meta = BUYBACK_RESULT_CODES[code] || { label: String(row.result_label || "unknown"), summary: "" };
    return {
      order_id: String(row.order_id ?? ""),
      template_id: String(row.template_id ?? ""),
      quality_level: String(row.quality_level ?? ""),
      item_price: String(row.item_price ?? ""),
      stack_size: String(row.stack_size ?? ""),
      max_unit_price: row.max_unit_price == null || row.max_unit_price === "" ? "" : String(row.max_unit_price),
      result_code: Number.isFinite(code) ? code : -1,
      result_hex: buybackCodeHex(code),
      result_label: String(row.result_label || meta.label || "unknown"),
      detail: String(row.detail || meta.summary || ""),
      ...overrides
    };
  }

  function extractBuybackReport(result) {
    if (!result) return null;
    const candidates = [];
    if (typeof result.buyback_report === "string") candidates.push(result.buyback_report);
    if (Array.isArray(result.rows)) {
      for (const row of result.rows) {
        if (typeof row?.buyback_report === "string") candidates.push(row.buyback_report);
        else if (row?.buyback_report && typeof row.buyback_report === "object") return row.buyback_report;
      }
    }
    if (Array.isArray(result.results)) {
      for (const set of result.results) {
        for (const row of set?.rows || []) {
          if (typeof row?.buyback_report === "string") candidates.push(row.buyback_report);
          else if (row?.buyback_report && typeof row.buyback_report === "object") return row.buyback_report;
        }
      }
    }
    for (const text of candidates) {
      try { return JSON.parse(text); } catch { /* keep looking */ }
    }
    return null;
  }

  function persistBuybackLog() {
    try {
      localStorage.setItem(buybackLogStorageKey, JSON.stringify(buybackLogEntries.slice(0, 500)));
    } catch { /* quota / private mode */ }
  }

  function restoreBuybackLog() {
    try {
      const parsed = JSON.parse(localStorage.getItem(buybackLogStorageKey) || "[]");
      if (Array.isArray(parsed)) buybackLogEntries = parsed.filter((entry) => entry && typeof entry === "object");
    } catch {
      buybackLogEntries = [];
    }
    renderBuybackLog();
  }

  function summarizeBuybackLogBatch(entries) {
    const counts = new Map();
    for (const entry of entries) {
      const key = entry.result_hex || buybackCodeHex(entry.result_code);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([hex, count]) => `${hex}×${count}`).join(", ");
  }

  function renderBuybackLog() {
    if (!buybackLogEl || !buybackLogMetaEl) return;
    if (!buybackLogEntries.length) {
      buybackLogMetaEl.textContent = "No buyback sweep attempts logged yet.";
      buybackLogEl.innerHTML = `<p class="muted">Run a buyback sweep or Refresh Log (dry-run) to classify player sell listings. Codes: 0x0 success, 0x1 price too high, 0x2 no reference price, 0x3 invalid price, 0x4 invalid stack, 0x5 max buys limit, 0x6 skipped locked.</p>`;
      return;
    }
    const latest = buybackLogEntries[0];
    buybackLogMetaEl.textContent = `${buybackLogEntries.length} log batch(es) stored. Latest: ${latest.source} at ${latest.at} — ${latest.summary || `${latest.entries?.length || 0} listings`}.`;
    buybackLogEl.innerHTML = buybackLogEntries.map((batch) => {
      const rows = (batch.entries || []).map((entry) => {
        const codeClass = entry.result_code === 0 ? "ok" : "error";
        return `<tr class="${codeClass}">
          <td><code>${escapeHtml(entry.result_hex)}</code></td>
          <td>${escapeHtml(entry.result_label)}</td>
          <td>${escapeHtml(entry.template_id)}</td>
          <td>${escapeHtml(entry.quality_level)}</td>
          <td>${escapeHtml(entry.item_price)}</td>
          <td>${escapeHtml(entry.stack_size)}</td>
          <td>${escapeHtml(entry.max_unit_price || "—")}</td>
          <td>${escapeHtml(entry.order_id)}</td>
          <td>${escapeHtml(entry.detail)}</td>
        </tr>`;
      }).join("");
      return `<div class="buyback-log-batch">
        <h3>${escapeHtml(batch.source)} <span class="muted">${escapeHtml(batch.at)}</span></h3>
        <p class="muted">${escapeHtml(batch.summary || "")}${batch.note ? ` — ${escapeHtml(batch.note)}` : ""}</p>
        <table>
          <thead><tr><th>Code</th><th>Result</th><th>Template</th><th>Grade</th><th>Ask/unit</th><th>Stack</th><th>Cap</th><th>Order</th><th>Detail</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="9" class="muted">No player sell listings on this exchange.</td></tr>`}</tbody>
        </table>
      </div>`;
    }).join("");
  }

  function appendBuybackLogBatch(entries, { source, note = "" } = {}) {
    const normalized = (entries || []).map((row) => normalizeBuybackLogRow(row)).filter(Boolean);
    buybackLogEntries.unshift({
      source: source || "Buyback",
      at: new Date().toLocaleString(),
      note,
      summary: `${normalized.length} listing(s); ${summarizeBuybackLogBatch(normalized) || "none"}`,
      entries: normalized
    });
    buybackLogEntries = buybackLogEntries.slice(0, 20);
    persistBuybackLog();
    renderBuybackLog();
  }

  async function queryBuybackClassification() {
    const result = await requestBridge("database.query", { query: buildBuybackClassifySql() });
    return (result?.rows || []).map((row) => normalizeBuybackLogRow(row)).filter(Boolean);
  }

  async function resolveBuybackLogAfterWrite(beforeEntries) {
    const report = extractBuybackReport(lastExecuteResult);
    if (report && Array.isArray(report.log)) {
      return report.log.map((row) => normalizeBuybackLogRow(row)).filter(Boolean);
    }
    // Bridges that discard execute SELECT rows: diff pre-classify vs remaining.
    let afterEntries = [];
    try {
      afterEntries = await queryBuybackClassification();
    } catch {
      return beforeEntries;
    }
    const remaining = new Set(afterEntries.map((entry) => entry.order_id));
    const maxBuys = currentMaxBuys();
    const boughtCount = beforeEntries.filter((entry) => entry.result_code === 0 && !remaining.has(entry.order_id)).length;
    const hitLimit = boughtCount >= maxBuys;
    return beforeEntries.map((entry) => {
      if (!remaining.has(entry.order_id)) {
        return normalizeBuybackLogRow({
          ...entry,
          result_code: 0,
          result_label: "success",
          detail: `bought stack ${entry.stack_size} at ${entry.item_price}/unit (cap ${entry.max_unit_price || "—"})`
        });
      }
      if (entry.result_code === 0 && entry.result_label === "eligible") {
        if (hitLimit) {
          return normalizeBuybackLogRow({
            ...entry,
            result_code: 5,
            result_label: "max buys limit",
            detail: `eligible but past Max Buys Per Sweep (${maxBuys})`
          });
        }
        return normalizeBuybackLogRow({
          ...entry,
          result_code: 6,
          result_label: "skipped locked",
          detail: "eligible but locked by a concurrent sweep"
        });
      }
      return entry;
    });
  }

  async function runBuybackSweep(label, options = {}) {
    const confirmPrompt = options.confirmPrompt !== false;
    if (confirmPrompt && !confirm(`${label}? RedBlink will create a database backup before this write. This may take some time.`)) {
      return false;
    }
    let beforeEntries = [];
    try {
      beforeEntries = await queryBuybackClassification();
    } catch (error) {
      // Classification is best-effort; the write may still succeed and return a report.
      statusEl.className = "status";
      statusEl.textContent = `${label}: could not pre-classify listings (${error.message || error}); continuing with write...`;
    }
    const ok = await runWrite(label, buildBuybackSql, { ...options, confirmPrompt: false });
    if (!ok) {
      if (beforeEntries.length) {
        appendBuybackLogBatch(beforeEntries, { source: label, note: "sweep did not complete; showing pre-classify codes" });
      }
      return false;
    }
    try {
      const entries = await resolveBuybackLogAfterWrite(beforeEntries);
      appendBuybackLogBatch(entries, { source: label });
      const bought = entries.filter((entry) => entry.result_code === 0 && entry.result_label === "success").length;
      const blocked = entries.length - bought;
      statusEl.className = "status ok";
      statusEl.textContent = `${label} complete. ${bought.toLocaleString()} bought, ${blocked.toLocaleString()} not bought — see Buyback Sweep Log.`;
    } catch (error) {
      if (beforeEntries.length) appendBuybackLogBatch(beforeEntries, { source: label, note: `post-log failed: ${error.message || error}` });
    }
    return true;
  }

  async function refreshBuybackLogDryRun() {
    try {
      const entries = await queryBuybackClassification();
      appendBuybackLogBatch(entries, { source: "Dry-run classify", note: "read-only; nothing purchased" });
      statusEl.className = "status ok";
      statusEl.textContent = `Buyback log refreshed: ${entries.length.toLocaleString()} player sell listing(s) classified (dry-run).`;
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
    }
  }

  function clearBuybackLog() {
    buybackLogEntries = [];
    persistBuybackLog();
    renderBuybackLog();
    statusEl.className = "status";
    statusEl.textContent = "Buyback sweep log cleared.";
  }

  function setAutoStatus(message, className = "status") {
    autoStatusEl.className = className;
    autoStatusEl.textContent = message;
  }

  function describeJobNext(label, nextAt) {
    if (!nextAt) return "";
    const remainingMs = Math.max(0, nextAt - Date.now());
    const minutes = Math.round(remainingMs / 60000);
    const when = minutes <= 0 ? "imminent" : `in ~${minutes} min`;
    return `${label} ${when}`;
  }

  function describeMarketOpsSchedule() {
    const parts = [];
    if (autoBuybackEl.checked) parts.push(describeJobNext("buyback", nextAutoRunAt));
    if (autoSeedEl.checked) parts.push(describeJobNext("seed", nextAutoSeedAt));
    if (autoCleanupEl.checked) parts.push(describeJobNext("cleanup", nextAutoCleanupAt));
    return parts.length ? parts.join("; ") : "no jobs armed";
  }

  function refreshMarketOpsStatus(prefix = "Auto market ops") {
    const enabled = [];
    if (autoBuybackEl.checked) enabled.push(`buyback every ${currentAutoIntervalMinutes()} min`);
    if (autoSeedEl.checked) enabled.push(`seed every ${currentAutoSeedIntervalMinutes()} min`);
    if (autoCleanupEl.checked) enabled.push(`unsafe cleanup every ${currentAutoCleanupIntervalMinutes()} min`);
    if (!enabled.length) {
      setAutoStatus(prefix === "Auto market ops" ? "Auto market ops are off." : `${prefix}.`);
      return;
    }
    setAutoStatus(`${prefix}: ${enabled.join(", ")} while this page stays open. ${describeMarketOpsSchedule()}.`);
  }

  async function runAutoBuyback() {
    autoRunning = true;
    nextAutoRunAt = Date.now() + currentAutoIntervalMinutes() * 60000;
    try {
      const checkResult = await requestBridge("database.query", { query: buildBuybackEligibilitySql() });
      const eligible = Number(checkResult?.rows?.[0]?.eligible_orders || 0);
      if (!Number.isFinite(eligible) || eligible <= 0) {
        try {
          const entries = await queryBuybackClassification();
          appendBuybackLogBatch(entries, { source: "Auto buyback (idle)", note: "nothing eligible; write skipped" });
        } catch { /* log is best-effort on idle ticks */ }
        setAutoStatus(`Auto buyback: nothing eligible at ${currentThreshold()}% threshold; skipped the write (and its backup). ${describeMarketOpsSchedule()}.`);
        return;
      }
      setAutoStatus(`Auto buyback: ${eligible.toLocaleString()} eligible player listings found; running sweep...`);
      const ok = await runBuybackSweep("Auto buyback sweep", { confirmPrompt: false });
      if (ok) {
        setAutoStatus(`Auto buyback: sweep finished at ${new Date().toLocaleTimeString()}. ${describeMarketOpsSchedule()}.`, "status ok");
      } else {
        setAutoStatus(`Auto buyback: sweep failed; check the status above. ${describeMarketOpsSchedule()}.`, "status error");
      }
    } catch (error) {
      setAutoStatus(`Auto buyback failed: ${error.message || String(error)}. ${describeMarketOpsSchedule()}.`, "status error");
    } finally {
      // Re-arm from completion time, not sweep start, so a write that outlasts
      // the interval cannot trigger back-to-back runs.
      nextAutoRunAt = Date.now() + currentAutoIntervalMinutes() * 60000;
      autoRunning = false;
    }
  }

  async function runAutoSeed() {
    autoRunning = true;
    nextAutoSeedAt = Date.now() + currentAutoSeedIntervalMinutes() * 60000;
    try {
      setAutoStatus("Auto seed: replacing NPC sell market...");
      const ok = await runWrite("Auto seed NPC sell market", () => buildSeedSql({ forceClear: true }), { confirmPrompt: false });
      if (ok) {
        setAutoStatus(`Auto seed: finished at ${new Date().toLocaleTimeString()}. ${describeMarketOpsSchedule()}.`, "status ok");
      } else {
        setAutoStatus(`Auto seed: failed; check the status above. ${describeMarketOpsSchedule()}.`, "status error");
      }
    } catch (error) {
      setAutoStatus(`Auto seed failed: ${error.message || String(error)}. ${describeMarketOpsSchedule()}.`, "status error");
    } finally {
      nextAutoSeedAt = Date.now() + currentAutoSeedIntervalMinutes() * 60000;
      autoRunning = false;
    }
  }

  async function runAutoCleanup() {
    autoRunning = true;
    nextAutoCleanupAt = Date.now() + currentAutoCleanupIntervalMinutes() * 60000;
    try {
      setAutoStatus("Auto cleanup: dropping unsafe NPC listings...");
      const ok = await runWrite("Auto drop unsafe NPC listings", buildDropUnsafeSql, { confirmPrompt: false });
      if (ok) {
        setAutoStatus(`Auto cleanup: finished at ${new Date().toLocaleTimeString()}. ${describeMarketOpsSchedule()}.`, "status ok");
      } else {
        setAutoStatus(`Auto cleanup: failed; check the status above. ${describeMarketOpsSchedule()}.`, "status error");
      }
    } catch (error) {
      setAutoStatus(`Auto cleanup failed: ${error.message || String(error)}. ${describeMarketOpsSchedule()}.`, "status error");
    } finally {
      nextAutoCleanupAt = Date.now() + currentAutoCleanupIntervalMinutes() * 60000;
      autoRunning = false;
    }
  }

  function marketOpsReady() {
    return Boolean(payload) && exchangesLoaded && Boolean(String(exchangeIdEl.value || "").trim());
  }

  function autoMarketOpsTick() {
    if (autoRunning || writeInProgress) return;
    if (!autoBuybackEl.checked && !autoSeedEl.checked && !autoCleanupEl.checked) return;
    if (!marketOpsReady()) {
      setAutoStatus("Auto market ops are waiting for an exchange to be selected.");
      return;
    }
    const now = Date.now();
    // Prefer cleanup, then seed, then buyback so a reseed starts from a clean
    // unsafe set and buyback sees the refreshed NPC reference stock.
    if (autoCleanupEl.checked && now >= nextAutoCleanupAt) {
      void runAutoCleanup();
      return;
    }
    if (autoSeedEl.checked && now >= nextAutoSeedAt) {
      void runAutoSeed();
      return;
    }
    if (autoBuybackEl.checked && now >= nextAutoRunAt) {
      void runAutoBuyback();
    }
  }

  function onAutoBuybackToggle() {
    if (autoBuybackEl.checked) {
      // First run happens one full interval after enabling, so turning the
      // feature on never fires an immediate surprise write.
      nextAutoRunAt = Date.now() + currentAutoIntervalMinutes() * 60000;
    } else {
      nextAutoRunAt = 0;
    }
    refreshMarketOpsStatus();
  }

  function onAutoSeedToggle() {
    if (autoSeedEl.checked) {
      nextAutoSeedAt = Date.now() + currentAutoSeedIntervalMinutes() * 60000;
    } else {
      nextAutoSeedAt = 0;
    }
    refreshMarketOpsStatus();
  }

  function onAutoCleanupToggle() {
    if (autoCleanupEl.checked) {
      nextAutoCleanupAt = Date.now() + currentAutoCleanupIntervalMinutes() * 60000;
    } else {
      nextAutoCleanupAt = 0;
    }
    refreshMarketOpsStatus();
  }

  // ---- Server-side buyback schedule ----
  //
  // Scheduler-capable consoles (Red-Blink/dune-awakening-selfhost-docker
  // PR #103) run the buyback loop inside the console API process, so sweeps
  // keep running after this page closes. The console builds all SQL for the
  // scheduler.* actions server-side from the bundled seed plan; this page only
  // sends typed parameters, never SQL. Older consoles answer these actions
  // with "Unsupported addon action", in which case the section stays hidden
  // and the in-page auto market ops remain the only automation.
  // Seed / unsafe-cleanup jobs are not in the console scheduler yet; use the
  // in-page auto seed and auto cleanup toggles for those.

  function setServerScheduleStatus(message, className = "status") {
    serverScheduleStatusEl.className = className;
    serverScheduleStatusEl.textContent = message;
  }

  function formatScheduleTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function serverScheduleFormValues() {
    const schedule = {
      enabled: serverScheduleEnabledEl.checked,
      intervalMinutes: clampInteger(serverIntervalMinutesEl.value, 30, 10, 1440),
      priceMultiplier: clampInteger(serverPriceMultiplierEl.value, 5, 1, 100),
      buybackPercent: clampInteger(serverBuybackPercentEl.value, 60, 1, 100),
      maxBuys: clampInteger(serverMaxBuysEl.value, 500, 1, 5000)
    };
    // exchangeId must travel as a string: BIGINT ids above
    // Number.MAX_SAFE_INTEGER lose precision through Number(). Omitting it
    // keeps the saved value (the console supports partial updates).
    const exchangeId = normalizeExchangeId(exchangeIdEl.value);
    if (exchangeId) schedule.exchangeId = exchangeId;
    return schedule;
  }

  function renderServerSchedule(schedule, { populateForm = false } = {}) {
    if (!schedule || typeof schedule !== "object") return;
    if (populateForm) {
      serverScheduleEnabledEl.checked = Boolean(schedule.enabled);
      if (schedule.intervalMinutes != null) serverIntervalMinutesEl.value = String(schedule.intervalMinutes);
      if (schedule.priceMultiplier != null) serverPriceMultiplierEl.value = String(schedule.priceMultiplier);
      if (schedule.buybackPercent != null) serverBuybackPercentEl.value = String(schedule.buybackPercent);
      if (schedule.maxBuys != null) serverMaxBuysEl.value = String(schedule.maxBuys);
    }
    const parts = [];
    if (schedule.enabled) {
      parts.push(`enabled, every ${formatNumber(schedule.intervalMinutes)} min on exchange ${schedule.exchangeId || "(none saved)"}`);
      if (schedule.nextRunAt) parts.push(`next run ${formatScheduleTime(schedule.nextRunAt)}`);
    } else {
      parts.push(schedule.exchangeId ? `disabled (saved exchange ${schedule.exchangeId})` : "disabled");
    }
    if (schedule.lastRunAt) {
      const runStatus = schedule.lastRunStatus ? ` (${schedule.lastRunStatus})` : "";
      const runDetail = schedule.lastRunDetail ? `: ${schedule.lastRunDetail}` : "";
      parts.push(`last run ${formatScheduleTime(schedule.lastRunAt)}${runStatus}${runDetail}`);
    } else {
      parts.push("no runs yet");
    }
    setServerScheduleStatus(`Server-side schedule: ${parts.join(" | ")}.`, schedule.lastRunStatus === "error" ? "status error" : "status");

    // Steer away from double buyback automation: with the server schedule
    // enabled the in-page buyback loop would run redundant sweeps, each
    // taking its own backup. Seed/cleanup stay available in-page because the
    // console scheduler does not run those jobs yet.
    if (schedule.enabled) {
      if (autoBuybackEl.checked) {
        autoBuybackEl.checked = false;
        persistSettings();
        onAutoBuybackToggle();
      }
      autoBuybackEl.disabled = true;
      refreshMarketOpsStatus("In-page buyback is off: the server-side schedule runs sweeps unattended");
    } else {
      autoBuybackEl.disabled = false;
      refreshMarketOpsStatus();
    }
  }

  async function loadServerSchedule({ populateForm = false, quiet = false } = {}) {
    if (serverScheduleRefreshInFlight) return;
    serverScheduleRefreshInFlight = true;
    try {
      const schedule = await requestBridge("scheduler.schedule.get");
      renderServerSchedule(schedule, { populateForm });
    } catch (error) {
      if (!quiet) setServerScheduleStatus(`Server-side schedule status failed to load: ${error.message || String(error)}`, "status error");
    } finally {
      serverScheduleRefreshInFlight = false;
    }
  }

  async function detectServerSchedule() {
    // Outside the console there is no bridge, so there is nothing to detect.
    if (window.parent === window) return;
    try {
      const schedule = await requestBridge("scheduler.schedule.get");
      serverScheduleSupported = true;
      serverScheduleSectionEl.hidden = false;
      renderServerSchedule(schedule, { populateForm: true });
    } catch (error) {
      const message = String(error?.message || error);
      // Older consoles reject the action outright; keep the section hidden and
      // leave the in-page auto buyback as the only automation.
      if (/unsupported addon action/i.test(message)) return;
      serverScheduleSupported = true;
      serverScheduleSectionEl.hidden = false;
      setServerScheduleStatus(`Server-side schedule status failed to load: ${message} Use Refresh Status to retry.`, "status error");
    }
  }

  async function saveServerSchedule() {
    if (serverScheduleSaveInFlight) return;
    serverScheduleSaveInFlight = true;
    const saveButton = document.getElementById("saveServerSchedule");
    saveButton.disabled = true;
    try {
      const schedule = serverScheduleFormValues();
      setServerScheduleStatus("Saving server-side schedule...");
      const saved = await requestBridge("scheduler.schedule.set", { schedule });
      renderServerSchedule(saved, { populateForm: true });
    } catch (error) {
      const message = error.message || String(error);
      const enabling = serverScheduleEnabledEl.checked;
      // Enabling needs the scheduler:server permission approved; point the
      // admin at the fix instead of leaving a bare permission error.
      const hint = enabling && /scheduler:server|permission|approved/i.test(message)
        ? " Approve the scheduler:server permission for this addon in the console's Addons panel, then save again."
        : "";
      setServerScheduleStatus(`Saving the server-side schedule failed: ${message}${hint}`, "status error");
    } finally {
      serverScheduleSaveInFlight = false;
      saveButton.disabled = false;
    }
  }

  async function probeServerSchedule() {
    if (serverProbeInFlight) return;
    serverProbeInFlight = true;
    const probeButton = document.getElementById("serverProbe");
    probeButton.disabled = true;
    try {
      // The probe accepts only these override fields; extras are rejected.
      const { exchangeId, priceMultiplier, buybackPercent, maxBuys } = serverScheduleFormValues();
      const overrides = { priceMultiplier, buybackPercent, maxBuys };
      if (exchangeId) overrides.exchangeId = exchangeId;
      setServerScheduleStatus("Probing eligibility (read-only; no backup is taken)...");
      const result = await requestBridge("scheduler.probe", overrides);
      const eligible = Number(result?.eligible || 0);
      setServerScheduleStatus(`Probe: ${eligible.toLocaleString()} eligible player listings on exchange ${result?.exchangeId || overrides.exchangeId || "?"} at ${result?.buybackPercent ?? overrides.buybackPercent}% threshold (read-only; no backup taken).`, "status ok");
    } catch (error) {
      setServerScheduleStatus(`Probe failed: ${error.message || String(error)}`, "status error");
    } finally {
      serverProbeInFlight = false;
      probeButton.disabled = false;
    }
  }

  async function runServerSweep() {
    if (writeInProgress) {
      setServerScheduleStatus("Another write is already in progress.", "status error");
      return;
    }
    writeInProgress = true;
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    setServerScheduleStatus("Server-side sweep starting with the saved schedule: the console probes eligibility first and takes a backup only when there is something to buy...");
    resultEl.textContent = "Running...";
    try {
      const result = await requestBridge("scheduler.run", {});
      resultEl.textContent = JSON.stringify(result, null, 2);
      // Render the returned schedule first so the sweep outcome message below
      // is what stays visible in the status area.
      if (result?.schedule) renderServerSchedule(result.schedule);
      if (result?.status === "swept") {
        setServerScheduleStatus(`Server-side sweep finished: bought ${formatNumber(result.purchased)} listings (${formatNumber(result.totalUnits)} units, ${formatNumber(result.totalSolari)} Solari).${result.detail ? ` ${result.detail}` : ""}`, "status ok");
      } else {
        setServerScheduleStatus(`Server-side sweep: nothing eligible; no backup was taken.${result?.detail ? ` ${result.detail}` : ""}`, "status ok");
      }
    } catch (error) {
      resultEl.textContent = error.stack || error.message || String(error);
      setServerScheduleStatus(`Server-side sweep failed: ${error.message || String(error)}`, "status error");
    } finally {
      writeInProgress = false;
      for (const button of document.querySelectorAll("button")) button.disabled = false;
    }
  }

  // Light status poll while the section is visible. The bridge rate limit
  // (~60 requests/min per addon+IP) is shared with every other call from this
  // page, so poll sparingly.
  function serverSchedulePollTick() {
    if (!serverScheduleSupported || writeInProgress) return;
    void loadServerSchedule({ quiet: true });
  }

  async function loadSeedPlan() {
    statusEl.className = "status";
    statusEl.textContent = "Loading bundled Easy Dune Admin market seed plan...";
    try {
      const response = await fetch("market-seed-plan.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`Seed plan returned HTTP ${response.status}.`);
      payload = await response.json();
      if (!localStorage.getItem(settingsStorageKey)) {
        multiplierEl.value = String(payload.price_multiplier || 5);
      }
      refreshPreview();
      await loadExchanges();
    } catch (error) {
      statusEl.className = "status error";
      statusEl.textContent = error.message || String(error);
    }
  }

  restoreSettings();
  restoreBuybackLog();
  onAutoBuybackToggle();
  onAutoSeedToggle();
  onAutoCleanupToggle();

  filterEl.addEventListener("input", renderRows);
  kindFilterEl.addEventListener("change", renderRows);
  multiplierEl.addEventListener("change", () => { persistSettings(); refreshPreview(); });
  for (const el of [thresholdEl, maxBuysEl, clearExistingEl]) {
    el.addEventListener("change", persistSettings);
  }
  autoBuybackEl.addEventListener("change", () => { persistSettings(); onAutoBuybackToggle(); });
  autoBuybackIntervalEl.addEventListener("change", () => { persistSettings(); if (autoBuybackEl.checked) onAutoBuybackToggle(); });
  autoSeedEl.addEventListener("change", () => { persistSettings(); onAutoSeedToggle(); });
  autoSeedIntervalEl.addEventListener("change", () => { persistSettings(); if (autoSeedEl.checked) onAutoSeedToggle(); });
  autoCleanupEl.addEventListener("change", () => { persistSettings(); onAutoCleanupToggle(); });
  autoCleanupIntervalEl.addEventListener("change", () => { persistSettings(); if (autoCleanupEl.checked) onAutoCleanupToggle(); });
  document.getElementById("refreshPreview").addEventListener("click", refreshPreview);
  document.getElementById("refreshExchanges").addEventListener("click", () => void loadExchanges());
  document.getElementById("addExchange").addEventListener("click", addManualExchange);
  document.getElementById("seedMarket").addEventListener("click", () => void runWrite("Seed NPC sell market", buildSeedSql));
  document.getElementById("buySweep").addEventListener("click", () => void runBuybackSweep("Run buyback sweep"));
  document.getElementById("refreshBuybackLog").addEventListener("click", () => void refreshBuybackLogDryRun());
  document.getElementById("clearBuybackLog").addEventListener("click", clearBuybackLog);
  document.getElementById("clearNpc").addEventListener("click", () => void runWrite("Clear EDA NPC listings", buildClearNpcSql, {
    confirmDetail: "This removes the EDA bot's listings from ALL exchanges, not just the selected one."
  }));
  document.getElementById("dropUnsafe").addEventListener("click", () => void runWrite("Drop unsafe NPC listings", buildDropUnsafeSql));
  document.getElementById("saveServerSchedule").addEventListener("click", () => void saveServerSchedule());
  document.getElementById("serverProbe").addEventListener("click", () => void probeServerSchedule());
  document.getElementById("serverRun").addEventListener("click", () => void runServerSweep());
  document.getElementById("refreshServerSchedule").addEventListener("click", () => void loadServerSchedule({ populateForm: true }));
  window.setInterval(autoMarketOpsTick, 15000);
  window.setInterval(serverSchedulePollTick, 45000);
  void detectServerSchedule();
  loadSeedPlan();
})();
