# Community index update for EDA Exchange Bot 0.13.1

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update. Follow RedBlink's
[publishing](https://github.com/Red-Blink/dune-docker-addon-template/blob/main/docs/publishing.md)
and
[addon-submission](https://github.com/Red-Blink/dune-docker-addons/blob/main/docs/addon-submission.md)
docs.

`index.json` here updates only the `eda-exchange-bot` entry and `updatedAt`
for 0.13.1.

## Release checklist (done for 0.13.1)

1. Current-version fields are **0.13.1**.
2. Tag `v0.13.1` was pushed; the Release workflow built
   `eda-exchange-bot-0.13.1.zip` with its `.sha256` asset:
   https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.13.1
3. Checksum
   `7b6cc18479a38c073154115fd17fa4a640cf363ac9958c62cfa4355b22e11336`
   is filled into `eda-exchange-bot.json` `sha256`. Re-verify with
   `sha256sum eda-exchange-bot-0.13.1.zip` if the archive is ever rebuilt.

## Submitting to Red-Blink/dune-docker-addons

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with
   `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`
   (update the existing manifest **in place**; do not add a new file per
   release).
3. In `index.json`, update **only** the `eda-exchange-bot` entry and
   `updatedAt`. Do not overwrite the whole file.
4. Keep `downloadUrl` pinned to the `v0.13.1` release asset (not
   `releases/latest/...`).
5. Open a PR to `Red-Blink/dune-docker-addons` titled
   **Update EDA Exchange Bot to 0.13.1**.

Permissions stay structured and include `scheduler:server`. Lifecycle fields
stay in `index.json` only (not in this addon's `addon.json`).
