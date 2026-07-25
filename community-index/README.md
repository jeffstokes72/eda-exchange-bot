# Community index update for EDA Exchange Bot 0.11.0

GitHub Actions released **v0.11.0** from this repository:

- Release: https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.11.0
- Package: https://github.com/jeffstokes72/eda-exchange-bot/releases/download/v0.11.0/eda-exchange-bot-0.11.0.zip
- SHA-256: `f5bd7e574c73d140fd6dc9bf47f049e6871608bef57497d6dbd89da552e810ac`

This agent cannot open a PR against `Red-Blink/dune-docker-addons` (no write access to that repo or your fork). To publish to the console catalog:

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`.
3. Copy `community-index/index.json` → `index.json` (or merge the `eda-exchange-bot` entry + `updatedAt`).
4. Open a PR to `Red-Blink/dune-docker-addons` with title: **Update EDA Exchange Bot to 0.11.0**.

Per RedBlink docs: update the existing manifest in place (do not create a new addon id file). Permissions are structured and include `scheduler:server`.
