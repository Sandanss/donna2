# Donna Todos

Internal Donna todo tracker for lightweight backlog management. It starts with reviewed seed items from the active backlog docs and stores edits locally in the browser.

```bash
npm install
npm run dev
npm run build
```

Data is stored in browser localStorage. Use JSON export/import in the app to move a backlog between browsers.

Completed and archived work is seeded into the expandable Done section.

Seed sources:

- `docs/ENGINEERING_BACKLOG.md`
- `docs/FEATURE_BACKLOG.md`
- `docs/plans/PROTOTYPE_PILOT_BACKLOG.md`
- `docs/plans/archive/BUG_TRACKER.md`
