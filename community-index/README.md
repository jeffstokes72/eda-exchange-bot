# Community index update for EDA Exchange Bot 0.13.3

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update. Follow RedBlink's
[publishing](https://github.com/Red-Blink/dune-docker-addon-template/blob/main/docs/publishing.md)
and
[addon-submission](https://github.com/Red-Blink/dune-docker-addons/blob/main/docs/addon-submission.md)
docs.

`index.json` here updates only the `eda-exchange-bot` entry and `updatedAt`
for 0.13.3.

## Release checklist for 0.13.3

1. Current-version fields are **0.13.3**.
2. Push tag `v0.13.3` so the Release workflow builds
   `eda-exchange-bot-0.13.3.zip` with its `.sha256` asset:
   https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.13.3
   0.13.3 replaces an earlier v0.13.3 build that was rolled back, so the
   workflow re-uploads the release assets with `--clobber`.
3. Copy the published asset's checksum into `eda-exchange-bot.json` `sha256`
   (still empty until the release exists). Verify with
   `sha256sum eda-exchange-bot-0.13.3.zip` against the `.sha256` asset.

## Submitting to Red-Blink/dune-docker-addons

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with
   `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`
   (update the existing manifest **in place**; do not add a new file per
   release).
3. In `index.json`, update **only** the `eda-exchange-bot` entry and
   `updatedAt`. Do not overwrite the whole file.
4. Keep `downloadUrl` pinned to the `v0.13.3` release asset (not
   `releases/latest/...`).
5. Open a PR to `Red-Blink/dune-docker-addons` titled
   **Update EDA Exchange Bot to 0.13.3**.

Permissions stay structured and include `scheduler:server`. Lifecycle fields
stay in `index.json` only (not in this addon's `addon.json`).
