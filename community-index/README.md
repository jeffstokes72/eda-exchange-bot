# Community index update for EDA Exchange Bot 0.14.0

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update. Follow RedBlink's
[publishing](https://github.com/Red-Blink/dune-docker-addon-template/blob/main/docs/publishing.md)
and
[addon-submission](https://github.com/Red-Blink/dune-docker-addons/blob/main/docs/addon-submission.md)
docs.

`index.json` here updates only the `eda-exchange-bot` entry and `updatedAt`
for 0.14.0.

## Release checklist for 0.14.0

1. Current-version fields are **0.14.0**.
2. Push tag `v0.14.0` so the Release workflow builds
   `eda-exchange-bot-0.14.0.zip` with its `.sha256` asset:
   https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.14.0
3. Checksum
   `11f8ec01ac76b8e24e68e8d3c9a586e805077243ccf9b097a19f9c4eb50082a8`
   is filled into `eda-exchange-bot.json` `sha256`. It matches the published
   `eda-exchange-bot-0.14.0.zip.sha256` asset and a local
   `sha256sum eda-exchange-bot-0.14.0.zip` of the downloaded archive.

## Submitting to Red-Blink/dune-docker-addons

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with
   `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`
   (update the existing manifest **in place**; do not add a new file per
   release).
3. In `index.json`, update **only** the `eda-exchange-bot` entry and
   `updatedAt`. Do not overwrite the whole file.
4. Keep `downloadUrl` pinned to the `v0.14.0` release asset (not
   `releases/latest/...`).
5. Open a PR to `Red-Blink/dune-docker-addons` titled
   **Update EDA Exchange Bot to 0.14.0**.

Permissions stay structured and include `scheduler:server`. Lifecycle fields
stay in `index.json` only (not in this addon's `addon.json`).
