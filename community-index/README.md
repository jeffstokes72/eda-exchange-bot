# Community index update for EDA Exchange Bot 0.13.2

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update.

## Release checklist

1. Confirm current-version fields are **0.13.2**.
2. Tag and push `v0.13.2`, wait for the release zip + `.sha256`.
3. Fill `sha256` in `eda-exchange-bot.json` from that asset before opening the
   catalog PR.
4. Update `addons/eda-exchange-bot.json` in place and only the
   `eda-exchange-bot` entry + `updatedAt` in `index.json`.
5. PR title: **Update EDA Exchange Bot to 0.13.2**.
