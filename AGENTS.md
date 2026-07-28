# AGENTS.md

## Cursor Cloud specific instructions

This repo is a development/test harness for the **EDA Exchange Bot** browser
addon (the shipped package is only `addon.json` + `web/`). There is no
long-running production server; standard commands live in `README.md` and
`package.json` (`node scripts/validate.js` to lint/validate the manifest,
`npm test` to run the behavioral suites).

### PostgreSQL for the `db-*.test.js` suites

The `db-*` suites shell out to the `psql` CLI (see `tests/helpers/db.js`). When
no server is reachable they **silently skip** instead of failing, so a green
`npm test` can still be hiding skipped suites — check the summary for
`# skipped`.

PostgreSQL 16 is installed in the VM snapshot, and a **superuser role plus a
database both named after `$USER` (`ubuntu`)** already exist. `psql` with no
host connects over the local unix socket using peer auth, so the OS user maps
straight to that superuser role and `tests/helpers/db.js` can create/drop its
own `eda_bot_test_*` databases with no `PG*` env vars set.

The cluster does **not** auto-start on boot in this container. If the psql
suites are skipping, start it once per session:

```bash
sudo pg_ctlcluster 16 main start   # then: pg_isready
```

Reset/recreate the role + database (only if they are ever missing) with:

```bash
sudo -u postgres psql -c "CREATE ROLE \"$USER\" LOGIN SUPERUSER;"
sudo -u postgres createdb -O "$USER" "$USER"
```

### Manual UI testing (`scripts/dev-console.js`)

`node scripts/dev-console.js --db <database> --port 8787` serves the addon in an
iframe with a psql-backed RedBlink bridge (manual testing only). Gotchas:

- The target database must already have `tests/fixtures/dune-schema.sql` loaded
  **and at least one row in `dune.dune_exchange_accesspoints`** (e.g.
  `INSERT INTO dune.dune_exchange_accesspoints (exchange_id) VALUES (1);`).
  Without an access point the addon detects no exchange and seeding raises
  "Exchange ... has no access point yet".
- After clicking **Seed NPC Sell Market** the status briefly shows a neutral
  "RedBlink is creating a backup before the database write..." message before
  turning green "Seed NPC sell market complete." — that neutral message is
  progress, not an error.
