# Community index update for EDA Exchange Bot 0.13.0

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update. Follow RedBlink's
[publishing](https://github.com/Red-Blink/dune-docker-addon-template/blob/main/docs/publishing.md)
and
[addon-submission](https://github.com/Red-Blink/dune-docker-addons/blob/main/docs/addon-submission.md)
docs.

`index.json` here was refreshed from `Red-Blink/dune-docker-addons@main` on
2026-07-30 with only the `eda-exchange-bot` entry and `updatedAt` changed.

## Release checklist (this repo first)

1. Confirm every current-version field is **0.13.0**:
   - `addon.json`
   - `package.json` / `package-lock.json`
   - `web/market-seed-plan.json` (`panel_version`)
   - `scripts/generate-seed-plan.py` (`panel_version`)
   - `CHANGELOG.md` top section
2. Create and push the matching tag (**with** the `v` prefix):

   ```bash
   git tag v0.13.0
   git push origin v0.13.0
   ```

3. Wait for the Release workflow to upload
   `eda-exchange-bot-0.13.0.zip` and `.sha256`:
   https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.13.0
4. Copy that checksum into `eda-exchange-bot.json` `sha256`. Do **not** open
   the community-index PR while `sha256` is empty — the console refuses
   installs without a matching checksum. Re-verify with
   `sha256sum eda-exchange-bot-0.13.0.zip` if the archive is ever rebuilt.

## Submitting to Red-Blink/dune-docker-addons

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with
   `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`
   (update the existing manifest **in place**; do not add a new file per
   release).
3. In `index.json`, update **only** the `eda-exchange-bot` entry and
   `updatedAt`. Do not overwrite the whole file — other addons publish their
   own versions there, and a stale copy would roll them back.
4. Keep `downloadUrl` pinned to the `v0.13.0` release asset (not
   `releases/latest/...`).
5. Open a PR to `Red-Blink/dune-docker-addons` titled
   **Update EDA Exchange Bot to 0.13.0**.

Permissions stay structured and include `scheduler:server`, which is in the
console's `ALLOWED_ADDON_PERMISSIONS` (`console/api/src/addons.js`). Lifecycle
fields stay in `index.json` only (not in this addon's `addon.json`).
