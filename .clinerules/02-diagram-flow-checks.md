---
paths:
  - "src/config/**"
  - "src/games/**"
  - "src/settings/**"
  - "src/start/**"
  - "src/assets/languages/**"
  - "src/main.tsx"
  - "src/App.tsx"
  - ".github/diagram/**"
  - "*.agent.md"
  - "SKILL.md"
---

# Diagram & Flow Checks

The project's architecture and persisted data model are documented as Mermaid diagrams in `.github/diagram/`:

- `.github/diagram/database-schema.md` — ER diagram of the persisted `AppConfig` document stored under `localStorage['flash-games.config']`: nested settings, key rebindings, mobile-control positions, and per-game highscore buckets.
- `.github/diagram/architecture-flow.md` — component architecture flowchart (main → App → StartPage → game → persistence layer) and the game view state machine (start / tutorial / loading / playing / paused / remap / gameover / victory / highscore).

## Before editing

1. Read the relevant diagram file(s) first.
2. Confirm the intended change matches the documented schema, state machine, and data flow.

## Flow checks (verify before finishing)

- **Persistence shape**: any new setting, keybinding, mobile-control, or highscore field must exist in the `AppConfig` shape documented in `database-schema.md`, be seeded in `src/config/default.config.json`, and be merged by `src/config/index.ts` (`mergeConfig`). Keep the single storage key `flash-games.config`; do not introduce unrelated storage keys.
- **State machine**: every page/view transition you touch must match the state machine in `architecture-flow.md`. No dead ends: every new view must be reachable and leaveable (for example victory → highscore → start / retry).
- **Component flow**: game logic stays isolated from the start-page shell; all persistence I/O funnels through `src/config/index.ts` (`readConfig` / `updateConfig`).
- **Localization flow**: player-facing strings are translation keys routed through `src/assets/languages/index.ts` into `en.json` / `ms.json` / `zh.json`.

## Keep diagrams in sync

- If you change the persisted schema, default config, game registry, view state machine, or module/data-flow wiring, update the matching Mermaid diagram(s) and their tables in `.github/diagram/` in the same change.
- Keep Mermaid syntax GitHub-compatible: quote labels, avoid unescaped double quotes inside attribute comments, and avoid raw square brackets inside node labels.
- Re-run the narrowest validation (`npm run build` / `npm run lint`) after code + diagram changes and report the result.