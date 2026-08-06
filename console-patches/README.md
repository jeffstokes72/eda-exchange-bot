# Console patches: server-side market reseed

RedBlink's console scheduler today only runs the EDA Exchange Bot **buyback**
job (`scheduler.schedule.*`). These files add a matching **seed** job so the
addon can schedule unattended market reseeds the same way.

## Bridge actions (mirror buyback)

| Action | Purpose |
| --- | --- |
| `scheduler.seed.schedule.get` | Read seed schedule + last/next run (`database:read`) |
| `scheduler.seed.schedule.set` | Save seed schedule; enabling needs `scheduler:server` |
| `scheduler.seed.run` | Run one reseed now (`database:write`); always backups first |

Schedule file: `runtime/addons/jobs/eda-exchange-bot/seed.json`

Fields: `enabled`, `intervalMinutes` (default **15**, clamp 10–1440),
`exchangeId` (decimal string), `priceMultiplier` (1–100, default 5),
`lastRunAt` / `lastRunStatus` / `lastRunDetail` / `nextRunAt`.

Every run: **backup → clear bot listings on that exchange → seed** from the
installed addon's `web/market-seed-plan.json`. Player listings are never
touched. Seed and buyback share one running lock.

## Apply to Red-Blink/dune-awakening-selfhost-docker

1. Copy `addonSeedJob.js` → `console/api/src/addonSeedJob.js`
2. Replace `console/api/src/addonJobs.js` with the patched copy here (or apply
   `addonJobs.js.diff`)
3. Apply `server.js.diff` (adds the three `scheduler.seed.*` bridge actions and
   imports `readSeedSchedule` / `saveSeedSchedule`)
4. Update `docs/addons/addon-scheduled-jobs.md` to document the seed job
5. Open a PR to RedBlink titled **Add server-side scheduled market reseed for EDA Exchange Bot**

Until a console build with these actions ships, the addon feature-detects
`scheduler.seed.schedule.get` and keeps the in-page reseed fallback.
