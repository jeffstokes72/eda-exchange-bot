# Community index update for EDA Exchange Bot 0.13.1

Staging copies of the two files that
[Red-Blink/dune-docker-addons](https://github.com/Red-Blink/dune-docker-addons)
needs for a catalog update. Follow RedBlink's
[publishing](https://github.com/Red-Blink/dune-docker-addon-template/blob/main/docs/publishing.md)
and
[addon-submission](https://github.com/Red-Blink/dune-docker-addons/blob/main/docs/addon-submission.md)
docs.

 here updates only the  entry and 
for 0.13.1.

## Release checklist (done for 0.13.1)

1. Current-version fields are **0.13.1**.
2. Tag  was pushed; the Release workflow built
    with its  asset:
   https://github.com/jeffstokes72/eda-exchange-bot/releases/tag/v0.13.1
3. Checksum from that published asset is filled into 
   . Re-verify with  if the
   archive is ever rebuilt.

## Submitting to Red-Blink/dune-docker-addons

1. Sync your fork of https://github.com/Red-Blink/dune-docker-addons with
   .
2. Copy  → 
   (update the existing manifest **in place**; do not add a new file per
   release).
3. In , update **only** the  entry and
   . Do not overwrite the whole file.
4. Keep  pinned to the  release asset (not
   ).
5. Open a PR to  titled
   **Update EDA Exchange Bot to 0.13.1**.

Permissions stay structured and include . Lifecycle fields
stay in  only (not in this addon's ).
