# Community index update for EDA Exchange Bot 0.12.0

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update. This agent cannot open a PR against that repo (no
write access to it or to your fork).

`index.json` here was refreshed from `Red-Blink/dune-docker-addons@main` on
2026-07-28 with only the `eda-exchange-bot` entry and `updatedAt` changed.

## Before submitting

`sha256` in `eda-exchange-bot.json` is intentionally empty: it must be the
checksum of the exact release archive, which only exists once the tag is
pushed. The console refuses to install a community addon whose checksum is
missing or does not match, so fill it in first.

1. Tag and push `v0.12.0`. The release workflow builds
   `eda-exchange-bot-0.12.0.zip` and uploads it with a `.sha256` asset.
2. Copy the checksum from that asset (or run
   `sha256sum eda-exchange-bot-0.12.0.zip`) into `sha256`.

## Submitting

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with
   `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`
   (update the existing manifest in place; RedBlink's docs say not to add a new
   file per release).
3. In `index.json`, update **only** the `eda-exchange-bot` entry and
   `updatedAt`. Do not overwrite the whole file — other addons publish their own
   versions there, and a stale copy would roll them back.
4. Open a PR to `Red-Blink/dune-docker-addons` titled
   **Update EDA Exchange Bot to 0.12.0**.

Permissions stay structured and include `scheduler:server`, which is in the
console's `ALLOWED_ADDON_PERMISSIONS` (`console/api/src/addons.js`).
