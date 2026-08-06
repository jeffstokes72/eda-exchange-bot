# Community index update for EDA Exchange Bot 0.13.6

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update. Follow RedBlink's
[publishing](https://github.com/Red-Blink/dune-docker-addon-template/blob/main/docs/publishing.md)
and
[addon-submission](https://github.com/Red-Blink/dune-docker-addons/blob/main/docs/addon-submission.md)
docs.

`index.json` here updates only the `eda-exchange-bot` entry and `updatedAt`
for 0.13.6.

## Release checklist for 0.13.6

1. Current-version fields are **0.13.6**.
2. Push tag `v0.13.6` so the Release workflow builds
   `eda-exchange-bot-0.13.6.zip` with its `.sha256` asset:
   https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.13.6
3. Checksum
   `56a8f8a35395792580f3c30d6295af0bc17660d2c6bf0794b3a3988062fdb34d`
   is filled into `eda-exchange-bot.json` `sha256`. It matches the published
   `eda-exchange-bot-0.13.6.zip.sha256` asset and a local
   `sha256sum eda-exchange-bot-0.13.6.zip` of the downloaded archive.

## Submitting to Red-Blink/dune-docker-addons

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with
   `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`
   (update the existing manifest **in place**; do not add a new file per
   release).
3. In `index.json`, update **only** the `eda-exchange-bot` entry and
   `updatedAt`. Do not overwrite the whole file.
4. Keep `downloadUrl` pinned to the `v0.13.6` release asset (not
   `releases/latest/...`).
5. Open a PR to `Red-Blink/dune-docker-addons` titled
   **Update EDA Exchange Bot to 0.13.6**.

Permissions stay structured and include `scheduler:server`. Lifecycle fields
stay in `index.json` only (not in this addon's `addon.json`).
