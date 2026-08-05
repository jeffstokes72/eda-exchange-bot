# Changelog

Notable changes to the EDA Exchange Bot addon. Written for RedBlink (console
maintainer review) and n00bGames (addon author), documenting what changed and
why.

## 0.13.3 - 2026-08-05

### Fixed

- **Buyback operations no longer follow the exchange selector mid-run**: a sweep
  is a chain of awaits (pre-classify → write → post-write verify → log), and
  each step re-read the dropdown. Switching exchanges while a classification
  request was in flight could write to one exchange and verify or log another,
  mixing results from several exchanges into one log. Each operation now
  captures the exchange id once (`options.exchangeId || currentExchangeIdValue()`)
  and passes it explicitly to `buildBuybackSql`, `buildBuybackEligibilitySql`,
  `buildBuybackClassifySql`, `queryBuybackClassification`, and
  `resolveBuybackLogAfterWrite`. Manual sweeps, automatic sweeps (captured
  before the eligibility probe), idle-tick classifications, and
  **Refresh Log (dry-run)** all use the captured value.

### Added

- **Buyback Sweep Log records its exchange**: log batches store `exchange_id`
  and every batch heading plus the latest-log summary shows `Exchange <id>`.
  Batches stored by earlier versions stay visible and are labeled
  `Legacy exchange unknown`. Sweep confirmations and status lines name the
  exchange being written to.

## 0.13.2 - 2026-08-03

### Fixed

- **Buyback never purchases NPC / bot sell stock**: player-sell filtering is now
  null-safe and shared across the write sweep, eligibility probe, and classify
  log — `COALESCE(is_npc_order, FALSE) = FALSE` and
  `owner_id IS DISTINCT FROM` the Revy bot. Under-cap NPC listings and
  mistagged bot-owned rows are left untouched.

## 0.13.1 - 2026-08-03

### Fixed

- **Buyback buys the whole stack when the unit ask qualifies**: eligibility is
  the per-unit (`qty 1`) ask versus the seeded grade cap. Quantity is again
  `GREATEST(items.stack_size, sell_orders.initial_stack_size)` so a listing
  whose item row still shows `stack_size = 1` while `initial_stack_size` holds
  the real listed count is paid and removed as one full stack — never a
  single-unit "Take Solari" for a multi-unit listing.

## 0.13.0 - 2026-07-30

### Added

- **Buyback Sweep Log** on the addon page: every manual or auto buyback attempt
  (and a dry-run Refresh Log) classifies each player sell listing on the
  selected exchange with a stable hex result code:
  - `0x0` success (bought; dry-run shows eligible as `0x0` / "eligible")
  - `0x1` price too high (ask/unit above threshold % of the seeded grade cap)
  - `0x2` no reference price (template not in the seed plan — there is **no
    live market average**; caps come only from seeded NPC prices)
  - `0x3` invalid price / `0x4` invalid stack
  - `0x5` max buys limit / `0x6` skipped locked (concurrent sweep)
  Log batches persist in `localStorage` for the browser session. The write
  sweep also returns a `buyback_report` JSON blob; when the bridge discards
  execute SELECT rows the UI falls back to a pre/post classify diff.

### Fixed

- **Buyback stack quantity overpaid after partial sales**: quantity used
  `GREATEST(items.stack_size, sell_orders.initial_stack_size)`, so a leftover
  of 1 unit on a listing that originally had 500 still paid for 500. Quantity
  is now `COALESCE(items.stack_size, sell_orders.initial_stack_size)` —
  remaining inventory when the item row exists, otherwise the list-time size.
  Full unsold stacks still pay in one pass because both fields match.

### Clarified

- **Stacks / multi-stacks**: `item_price` is per-unit; if that qty-1 ask is
  under the cap, the listing is bought as one order for the whole
  `GREATEST(items.stack_size, sell_orders.initial_stack_size)` quantity.
  Separate stacks are separate orders and are evaluated independently
  (cheapest first, up to Max Buys Per Sweep).
- **Server-side schedule is no longer behind on pricing**: RedBlink's
  `addonJobs.js` (2026-07-29 "align scheduled buybacks with EDA pricing") uses
  the same per-grade caps, whole-stack quantity, and nearest-grade fallback as
  the in-page sweep. Older consoles may still use grade-0 base caps /
  single-unit stacks — upgrade if unattended buys look wrong. The Buyback
  Sweep Log only covers in-page runs.
- **Buyback log 0x5/0x6 labeling**: leftover eligible rows are ranked by the
  same price/id order as the buy loop. Ranks past Max Buys → `0x5`; ranks
  within the limit that were not bought → `0x6`. Hitting the buy cap no longer
  mislabels `SKIP LOCKED` rows as max-buys.
- **Buyback log fallback without `buyback_report`**: vanished eligible listings
  are only marked `0x0` when a `completion_type = 4` fulfilled-order row
  confirms a payment; otherwise they stay `0x6` instead of assuming this sweep
  bought them.
- **Release / community-index packaging**: version fields aligned to **0.13.0**
  (`addon.json`, `package.json` / lockfile, seed-plan `panel_version`, staged
  community-index manifest). Release docs now match RedBlink's template:
  tag `v0.13.0`, pin the release zip (not GitHub source archives), fill
  `sha256` from that asset, and update `addons/eda-exchange-bot.json` in place
  without overwriting other catalog entries.

## 0.12.0 - 2026-07-28

### Fixed

- **Buyback caps miss true 60% of seeded grade prices**: after grades were
  baked into the seed plan, buyback still derived a single grade-0/1 base and
  re-applied grade multipliers in SQL (`FLOOR(cap × grade_mult)`). Seeded
  grade prices are not exactly `q0 × mult` after stepped rounding, so hundreds
  of grade rows undershot (or overshot) **60% of the seeded market at that
  grade**. Caps are now one row per `(template_id, quality_level)` =
  `ceil(seeded_price × buyback%)`, joined on the listing's grade. Player
  listings never enter the reference price (there is no live market average
  in this addon); cheap player posts cannot dilute the buyback threshold.
- **Resource stacks paid as one unit**: buyback used
  `COALESCE(items.stack_size, sell_orders.initial_stack_size)`. Player
  resource listings can leave `items.stack_size = 1` while the real quantity
  sits on `initial_stack_size`, so the sweep paid for 1 unit, wrote a 1-unit
  "Take Solari" payment, and deleted the rest of the stack. Quantity is now
  `GREATEST(item stack, sell-order initial stack)` so a full resource listing
  is bought and paid in one pass.
- **Tools and Tier 1–5 seeded with fake ranks**: every schematic was forced
  through quality grades 1–5, so sand compactors, vehicles, and T1–5 gear
  schematics showed in-game as Rank 1–5. Ranks are limited to catalog-gradeable
  **T6 armor / weapons / stillsuits / augments**. Armor/weapons/stillsuits keep
  physical stock q0 plus ranks 1–5; **augments are ranks 1–5 only** (no rank 0;
  start at catalog `min_quality_level` when higher). Matching schematics stay
  1–5. Tools and lower tiers stay quality 0. Augments the catalog does not mark
  gradeable seed a single **rank 1** listing rather than rank 0, matching
  Console's `normalizeStandaloneAugmentQuality`, which lifts any
  `T<n>_Augment_` item below rank 1 up to rank 1.
- **Listings whose grade the plan does not seed were silently unbuyable**:
  matching the plan on the listing's exact grade dropped every listing at a
  grade the plan deliberately skips (tools and Tier 1–5 are stock-only,
  augments start at rank 1 or their catalog minimum), counting them as unknown
  templates. The plan lookup now takes the listing's own grade when it is
  seeded and otherwise the nearest seeded grade **below** it, so an unseeded
  grade is capped by a cheaper reference instead of being skipped.
- **Ranks stored only on the backing item priced the listing as rank 0**:
  `dune_exchange_orders.quality_level` is `NOT NULL DEFAULT 0`, so the
  `COALESCE(order, item)` fallback could never reach `dune.items`. The grade is
  now the higher of the two rows, since rank 0 means "no rank".
- **Unattended reseed could stack duplicate markets**: auto seed reused the
  "clear existing" checkbox, so with it unchecked every interval appended
  another full bot market (~5,800 listings) to the exchange. Auto seed now
  always clears the bot's own listings for the selected exchange first; the
  checkbox still controls manual seeding.
- **Buyback plan tolerates an empty plan table**: the sweep's temp
  `market_buy_plan` now seeds a NULL-safe row and removes it, so an empty or
  filtered-out plan no longer turns `INSERT ... VALUES ;` into a syntax error.
  The manual sweep already fails fast before that, but the unattended path now
  surfaces "0 purchased" instead of crashing the transaction.
- **Seeding tolerates an empty plan table** the same way (a no-op reseed rather
  than a malformed `VALUES` clause).
- **Server-side console note**: RedBlink's `addonJobs.js` still builds the
  older template-only buyback SQL with `COALESCE(items.stack_size, …, 1)`.
  In-page / manual sweeps use the fixed math immediately; unattended server
  sweeps keep the old caps and the single-unit stack behavior until the
  console ships a matching update. The server schedule panel now says so.

### Added

- **In-page auto seed and auto unsafe cleanup**: optional schedulers (default
  every 360 minutes) that reseed the NPC market and drop unsafe NPC listings
  while the addon page stays open, alongside auto buyback. Jobs share a
  single write lock; cleanup runs before seed before buyback when multiple
  are due. Settings persist in `localStorage`.
- Server schedule panel copy clarifies that seed/cleanup are not yet console
  scheduler jobs — use the in-page toggles for those.

## 0.11.1 - 2026-07-27

### Fixed

- **Seed SQL casts item stats to `jsonb`**: `dune.items.stats` is `jsonb` in
  the live game DB. 0.11.0 inserted plan `item_stats` as plain `text`, which
  failed with `column "stats" is of type jsonb but expression is of type text`.
  The insert now uses `rec.item_stats::jsonb`. The test schema matches
  production (`JSONB`) so this cannot regress silently.
- **Panel reports 0.11.1**: `panel_version` in `web/market-seed-plan.json` (and
  the generator's stamp in `scripts/generate-seed-plan.py`) still said 0.11.0,
  so the preview status line showed the old version. Community-index files and
  the README release example now reference v0.11.1 as well.

## 0.11.0 - 2026-07-25

Full market seed overhaul from Easy Dune Admin's authoritative
`item-data.json` catalog, with grades and durability baked into the plan.

### Changed

- **Regenerated `web/market-seed-plan.json`** from vendored
  `data/item-data.json` via `scripts/generate-seed-plan.py` (~4300 unique
  rows / ~8600 listings). Pricing follows EDA's vendor-price × rarity model
  with grade multipliers `[1, 1, 1.25, 1.5, 1.75, 2]`.
- **Schematic grades 1-5 are baked into the seed** for T6 rankable
  armor/weapons/stillsuits/augments only (2 listings per grade). Tools,
  vehicles, and Tier 1–5 gear (and their schematics) stay at quality 0.
  The UI checkbox / per-grade / material-listings controls are removed; the
  preview and seed SQL use the plan rows as shipped.
- **Durability on seeded items** is absolute **100–200** (base 100, inflated
  by tier and quality grade up to 200), written into
  `dune.items.stats` as `FItemStackAndDurabilityStats`. Exchange order
  `durability_cur` / `durability_max` stay at the normalized wear fraction
  **1.0 / 1.0** (full condition), matching EDA.
- **Stillsuits** are treated as rankable armor when the catalog marks them
  gradeable. **Augments** and their schematics keep ranks. **Vehicle
  components** are stocked without ranks (vehicle schematics still use the
  normal schematic grade bake).
- **Uniques** stock through tier 6; T6 gradeable gear (e.g. Dunewatcher)
  includes stock (q0) plus ranks 1–5. Commodities use catalog `stack_max`
  (e.g. Spice Residue 1000, Iron Ingot 500) with 2 listings each.
- **Exclusions**: contracts, cosmetics/customization, construction, emotes,
  mementos / plot / story / “green” items (Zantara’s Crysknife, Phaedra’s
  Mask, The Jackal’s Blindfold, etc.), social wearables, and unusable set
  packs (“Bene Gesserit set”-style bundles). Individual themed pieces such
  as Acheronian armor remain.

### Tests

- New `tests/seed-plan.test.js` covers baked schematic/T6 grades, max
  stacks, durability range, plot/set exclusions, and seed SQL writing
  absolute durability into item stats while keeping order wear at 1.0.
- Harness fixture seed rows include durability; db seeding listing count
  matches the no-UI-expansion plan (12 listings).
- Buyback caps use the seeded **grade 0** (else schematic grade 1) price
  directly so stepped rounding on higher grades cannot inflate recovered
  bases (~6.7% overpay). Sweeps and eligibility probes require
  `item_price > 0` and stack `> 0`.

## 0.10.0 - 2026-07-24

Unattended buyback through the console's new server-side addon scheduler
([Red-Blink/dune-awakening-selfhost-docker#103](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/103)).
The console API process now runs the buyback loop itself, so the sweep no
longer requires this addon's page to stay open in a browser.

### Added

- **Server-Side Buyback Schedule panel**: saves the schedule (enabled,
  interval 10-1440 minutes, exchange, price multiplier, buyback percent, max
  buys) to the console through the typed `scheduler.schedule.get` /
  `scheduler.schedule.set` bridge actions, shows live status (next run, last
  run outcome and detail), and offers **Probe Now** (`scheduler.probe`,
  read-only, no backup) and **Run Sweep Now** (`scheduler.run`, uses the
  saved schedule; probes first and takes a backup only when eligible
  listings exist). The panel polls status every 45 seconds while visible,
  well inside the shared ~60 requests/min bridge rate limit.
- The exchange for the schedule is the one selected in Exchange Controls at
  save time, always sent as a decimal string so 64-bit exchange ids survive
  (same rule as the rest of the addon).
- **Feature detection**: on load the addon calls `scheduler.schedule.get`;
  consoles without scheduler support answer "Unsupported addon action" and
  the section stays hidden, leaving the in-page auto buyback exactly as
  before. Validation and permission errors from the console surface in the
  panel's status area, including an actionable hint when enabling fails
  because `scheduler:server` was not approved.
- **Double-automation steering**: while the server-side schedule is enabled,
  the in-page auto buyback checkbox is unchecked and disabled. Concurrent
  sweeps are safe at the database level (`FOR UPDATE OF o, s SKIP LOCKED`)
  but redundant, and each takes its own backup.
- **Run Sweep Now** shares the `writeInProgress` guard with the SQL write
  buttons: a server-side run refuses to start during a manual write and vice
  versa, and all buttons lock while it is in flight.

### Changed

- `addon.json` now requests the `scheduler:server` permission (object form:
  `"scheduler": ["server"]`) alongside database read/write, and the version
  is 0.10.0.
- **Compatibility**: older console builds reject manifests that request
  unknown permissions, so 0.10.x only installs on console builds with
  scheduler support. Keep 0.9.x for older consoles; its in-page auto buyback
  is unchanged and remains in 0.10.x as the fallback (the SQL builders and
  the 15-second tick loop are untouched).
- `scripts/validate.js` allows the new `scheduler:server` permission.

### Tests

- New `tests/server-schedule.test.js` covers: feature-detection fallback on
  older consoles, schedule form to `scheduler.schedule.set` payload mapping
  (including string `exchangeId` and omitting it for partial updates),
  the `scheduler:server` permission-error hint, probe payload/result wiring,
  run-sweep button locking against manual writes (both directions), the
  in-page auto buyback steering, and quiet status polling that does not stomp
  form edits.
- `tests/helpers/harness.js` routes `scheduler.*` bridge actions to a mock
  handler that defaults to the pre-scheduler console reply ("Unsupported
  addon action"), so every existing test now also exercises the fallback
  path.

## 0.9.2 - 2026-07-19

Fix for the buyback concurrency issue from RedBlink's 0.9.1 review, plus a
corrected release. This entry was previously mislabeled as a second 0.9.1
section: the concurrency fix was tagged `0.9.1` (without the `v` prefix), so
the `v*` release workflow never rebuilt the archive and the published v0.9.1
zip did not contain it. 0.9.2 is a clean, immutable release built from the
corrected source.

### Release

- Republished as `v0.9.2` so the release workflow rebuilds the archive from
  the corrected source; the published zip now contains the concurrency fix.
- Version fields aligned: `addon.json`, `package.json`, and the release tag
  all report 0.9.2 (they previously disagreed between 0.9.1 and 0.9.2).
- Removed stale committed `dist/` archives (0.9.0 and 0.9.1) from the
  repository; `dist/` is gitignored and release archives are built by the
  `v*` tag workflow. The committed 0.9.1 zip's checksum no longer matched
  the published release asset, which is what broke the catalog manifest's
  SHA-256.

### Fixed

- **Database-level buyback concurrency protection**: the buyback sweep's
  order-selection loop now locks the rows it processes with
  `FOR UPDATE OF o, s SKIP LOCKED`. The existing `writeInProgress` flag only
  protects a single browser page; two tabs or administrators sweeping at the
  same time could previously select the same player order twice, creating a
  duplicate seller payment and debiting the bot's balance twice. With row
  locking, a concurrent sweep skips orders another sweep has already claimed
  (and rows deleted by a committed sweep drop out of the re-checked result),
  so each order is purchased exactly once no matter how many sweeps run.
- The sweep no longer calls `dune_exchange_get_user_id` (its result was
  unused): the function's `INSERT .. ON CONFLICT` would block on another
  sweep's uncommitted balance update, needlessly serializing sweeps that
  `SKIP LOCKED` lets run side by side. The balance top-up still creates the
  bot's exchange-users row when it is missing.

### Tests

- New PostgreSQL-backed concurrency test
  (`tests/db-buyback-concurrency.test.js`) runs two sweeps on separate
  database connections against the same eligible order, both as overlapping
  transactions (the second runs while the first is still uncommitted) and as
  a simultaneous race. It verifies the order is purchased exactly once, only
  one payment record is created, and the bot's balance is deducted exactly
  once; without the row locking the test fails with a double purchase.
- `tests/helpers/db.js` gained `openSession()`: a long-lived interactive
  psql session (one connection per session) so tests can hold a transaction
  open while another runs concurrently.

## 0.9.1 - 2026-07-19

Fixes for the two blocking issues from RedBlink's 0.9.0 review, plus the
behavioral test suite requested with them.

### Fixed

- **BIGINT exchange ids preserved exactly**: exchange ids are now handled as
  validated decimal strings (`/^[1-9][0-9]*$/`, capped at the PostgreSQL
  BIGINT maximum) end-to-end: the dropdown, the remembered-id storage, and
  the generated SQL. They are never converted with `Number()`, so BIGINT ids
  above `Number.MAX_SAFE_INTEGER` (2^53 - 1) can no longer lose precision and
  target the wrong exchange. `BigInt` is used only for numeric sorting of the
  dropdown. The manual "Remember Exchange ID" input became a text field with
  numeric input hints so the browser cannot round large ids either.
- **"Clear existing listings before seeding" is scoped to the selected
  exchange**: the pre-seed cleanup now resolves the selected exchange first
  and constrains every order, sell-order, and backing-item deletion to
  `owner_id = v_owner_id AND exchange_id = v_exchange_id`. Reseeding one
  exchange no longer removes the bot's listings from every other seeded
  exchange. The checkbox label now says "the selected exchange's" listings.
- The explicit **Clear EDA NPC Listings** action intentionally stays global,
  and its confirmation prompt now states that it removes the bot's listings
  from ALL exchanges, not just the selected one.

### Tests

New behavioral test suite (`npm test`, run by CI): jsdom drives the real
addon page against a mock RedBlink bridge, and the captured SQL is executed
against a real PostgreSQL server with a minimal replica of the exchange
schema (`tests/fixtures/dune-schema.sql`). Covered:

- Exact preservation of 64-bit exchange ids (2^53 + 1 and BIGINT max)
  through the dropdown, localStorage, generated SQL, and database rows.
- Seeding cleanup affecting only the selected exchange (reseeding exchange A
  leaves exchange B's orders byte-for-byte intact).
- Global cleanup behavior (bot listings removed from every exchange, player
  listings spared, confirmation warns about all exchanges).
- Buyback SQL generation and payment records (threshold rounding, grade
  normalization, per-unit seller payments with the never-expires sentinel,
  fulfilled-order audit rows, Solari balance movement, exchange scoping).
- Manual and automatic buyback concurrency (single write in flight, auto
  ticks skipped during manual writes, no immediate run on arming, idle ticks
  skip the write).

The test harness (`package.json`, `tests/`) is development-only; the shipped
addon package remains `addon.json` plus `web/`.

## 0.9.0 - 2026-07-11

### Template adherence ([dune-docker-addon-template](https://github.com/Red-Blink/dune-docker-addon-template))

- Split the single-file `web/index.html` (inline styles and script) into
  `web/index.html` + `web/addon.js` + `web/addon.css`, matching the template's
  repository layout. No behavior was lost in the split; all behavior changes
  are listed below.
- Rewrote `README.md` to follow the template's structure (validate, local
  development, package, release, community-index submission) and removed
  references to `install-eda-exchange-bot.sh` and
  `patch-redblink-local-addons.sh`, which were documented but not present in
  this repository. Local testing now follows the template's documented flow
  (copy `addon.json` + `web/` into `runtime/addons/installed/`, enable via
  `runtime/addons/state.json`).
- The GitHub workflows and `scripts/validate.js` already matched the template
  byte-for-byte and are unchanged. The addon package remains `addon.json` plus
  `web/` only.

### Fixes ported from Easy Dune Admin's exchange seeder ([Icehunter/dune-admin `internal/marketbot`](https://github.com/Icehunter/dune-admin/tree/main/internal/marketbot))

- **Seller payment fix** ("items eaten without payment"): buyback payment
  entries ("Take Solari" rows) now use the never-expires sentinel expiration
  `999999999` instead of a derived future timestamp. The game server's
  `dune_exchange_expire_orders` proc runs about every 5 minutes and purges
  past-dated orders; a payment entry that lands in the past means the seller's
  item is consumed with no Solari paid out. `item_price` on the payment entry
  stays per-unit (the game multiplies by stack size itself).
- **Access-point detection**: market seeding resolves the access point from
  `dune.dune_exchange_accesspoints` first (authoritative: it is what the game
  client uses), falls back to an existing order's access point, and raises a
  clear error instead of fabricating id `1`. A fabricated id violates the
  foreign key and produces listings players cannot see in-game. The exchange
  selector also shows access-point counts and prefers exchanges that have one.
- **Listing expiry**: seeded-listing expiration is derived from the newest
  non-sentinel order and capped at the sentinel, so sentinel payment rows can
  no longer inflate the computed expiry past `999999999`.
- **Balance seeding**: the bot's Solari balance is topped up to 9T only when
  it dips below the 1T floor, instead of topping up on every run.
- **Grade multipliers**: adopted the marketbot's quality-grade price
  multipliers `[1.0, 1.0, 1.25, 1.5, 1.75, 2.0]` (grades 0-5) for both
  listing prices and grade-aware buyback thresholds.

### New features

- **Schematics at grades 1-5**: every schematic in the seed plan now lists at
  quality grades 1 through 5, with 2 listings per grade by default
  (configurable 1-20), priced with the grade multipliers above. At defaults
  this turns 496 schematic templates into 4,960 schematic listings.
- **More materials**: each material (resource row) now seeds 4 listings by
  default (configurable 1-50) instead of a single listing: 102 material
  listings become 408 (~189k resource units).
- **Auto buyback**: an opt-in scheduler runs the buyback sweep on an interval
  (default 30 minutes, minimum 10) while the addon page is open in the
  console. Designed to be gentle on self-hosted infrastructure:
  - Every tick starts with a **read-only** eligibility query through
    `database.query`, which takes no backup. The backup-protected
    `database.execute` sweep only runs when at least one eligible player
    listing exists, so idle ticks are cheap.
  - Arming the toggle never fires immediately; the first run happens one full
    interval after enabling.
  - The interval is measured from sweep completion, so a slow backup or write
    can never cause back-to-back runs.
  - Because addons are iframe pages with no server-side scheduler in the
    bridge, the automation runs only while the page is open.
- **Grade-aware buyback**: player listings are compared against a
  grade-adjusted reference price (the order's `quality_level` applied to the
  same grade multipliers used for seeding) before the buyback threshold
  percentage is applied.
- Panel settings (multiplier, threshold, max buys, grade/material counts,
  auto-buyback toggle and interval) persist in browser `localStorage`. The
  seed-row preview table gained a Grade column and grade filtering.

### Fixes from Cursor Bugbot review of this release

- **Overlapping write sweeps**: `executeWrite` returns early when a write is
  already in progress, closing a race where a manual sweep started during the
  auto-buyback eligibility probe could run concurrently with the auto sweep.
- **Auto buyback false success**: write helpers return a success flag and the
  auto status reports failed sweeps instead of always showing "sweep
  finished".
- **Auto interval ignores long writes**: the next-run timer re-arms from
  completion time in a `finally` block (see auto-buyback design above).
- **Buyback double-applied grade pricing**: 77 bundled plan rows (T6
  augments) carry a non-zero `quality_level` with already grade-adjusted
  prices; they are now normalized back to grade-0 prices before the buyback
  plan is built, since the SQL applies the grade multiplier itself.

### Housekeeping

- Version bumped from `0.8.7-beta` to `0.9.0` in `addon.json`.

## 0.8.7-beta

Baseline release: single-file addon page with market seed preview, manual
seed / buyback / clear / drop-unsafe actions, and the bundled Easy Dune Admin
market seed plan.
