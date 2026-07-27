# Community index update for EDA Exchange Bot 0.11.1

GitHub Actions released **v0.11.1** from this repository:

- Release: https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.11.1
- Package: https://github.com/jeffstokes72/eda-exchange-bot/releases/download/v0.11.1/eda-exchange-bot-0.11.1.zip
- SHA-256: `81786bcf0faef0a9d4f7a5d4772da7ed13a8621e55f4d6dc9e594a7d7920d98f`

This agent cannot open a PR against `Red-Blink/dune-docker-addons` (no write access to that repo or your fork). To publish to the console catalog:

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with `upstream/main`.
2. Copy `community-index/eda-exchange-bot.json` → `addons/eda-exchange-bot.json`.
3. Copy `community-index/index.json` → `index.json` (or merge the `eda-exchange-bot` entry + `updatedAt`).
4. Open a PR to `Red-Blink/dune-docker-addons` with title: **Update EDA Exchange Bot to 0.11.1**.

Per RedBlink docs: update the existing manifest in place (do not create a new addon id file). Permissions are structured and include `scheduler:server`.
