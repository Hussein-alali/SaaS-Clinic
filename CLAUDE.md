# Project rules

## Keep the six planning docs in sync

Every code, config, schema or deployment change must also update the six
planning documents in `docs/`, in the same commit or PR:

1. `docs/01-PRD.md` — features, goals, acceptance criteria (mark met ones ✅), open questions
2. `docs/02-TRD.md` — stack, architecture, data access, performance targets, decisions
3. `docs/03-App-Flow.md` — screens, entry points, actions and their states
4. `docs/04-UI-UX-Brief.md` — components, interaction states, performance budget
5. `docs/05-Backend-Schema.md` — tables, access rules, migrations
6. `docs/06-Implementation-Plan.md` — task status (✅), new tasks, dependencies

Update only the sections the change affects, and add a row to the
`## سجل التغييرات` table at the end of each doc you touch (date, what
changed, commit). The docs are written in Arabic; keep identifiers in
English.

## Build

- `npm install`, then `npm run build` → `dist/` (esbuild precompile, see `scripts/build.mjs`).
- `npm start` serves `dist/`; `npm run dev` serves the raw sources with in-browser Babel.
- `src/*.jsx` are classic scripts sharing globals (no imports); the build
  concatenates them in `index.html` order. A new file must be added to
  `index.html`.
