# Plan — Decompose `src/App.css` into per-component stylesheets

## Goal

Replace the single global `src/App.css` with co-located per-component CSS files, imported by the components that own them, and codify this as a permanent standard in `.clinerules/01-flash-game-builder.md` and `.github/agents/flash-game-builder.agent.md`.

## Why a checkpoint protocol

A previous session died with `SocketError: other side closed` while executing this plan in one large burst. From now on this plan runs in small numbered steps, one per session turn, with a build/lint checkpoint after every step.

## Checkpoint workflow

1. Run ONE step per session turn.
2. After each step run `npm run build` and `npm run lint`, report results, then STOP.
3. Do not start the next step until the user replies with "next".
4. Every shell command stays small, non-interactive, and ends with a `---done---` sentinel.
5. If interrupted, read `plan.md`, confirm the last completed step, and continue from there.

## Progress

- [x] Step 1 — Global base → src/index.css
- [x] Step 2 — src/start/StartPage.css
- [x] Step 3 — src/credits/CreditsPage.css
- [x] Step 4 — src/settings/SettingsModal.css
- [x] Step 5 — src/settings/ControllerSettings.css
- [x] Step 6 — HighscoreTable.css
- [x] Step 7 — BubbleTroubleGame.css
- [x] Step 8 — Remove src/App.css
- [x] Step 9 — Codify rule (01 + agent mirror)
- [ ] Step 10 — Consistency sync (skills + terminal rules)
- [ ] Step 11 — Final validation
- [ ] Step 12 — Fix pre-existing lint findings

## Hard rules for every step

- Zero visual change: rules move verbatim; only file boundaries and imports change.
- Plain global class names stay (no CSS Modules), so no JSX `className` strings change.
- The build must be green after every step.
- Never define the same rule in two files.
- Combined media-query selectors (e.g. `.start-page, .credits-page, .bubble-page`) are split per owner, one `@media` block per file, keeping exact declarations.
- Shared primitives live once in `src/index.css`; component reuse is an explicit stylesheet import (e.g. `ControllerSettings` imports `./SettingsModal.css` for `.setting-control`, `.setting-label`, `.music-toggle`).

## Steps (one per turn, checkpoint after each)

### Step 1 — Global base → src/index.css
Move to `src/index.css`: fonts `@import`, `#root`, `.brand-mark`, `.text-button` (+`:hover`), `.eyebrow`, `h1`, `h1 em`. Remove those rules from `src/App.css`. No component file changes. Validate + checkpoint.

### Step 2 — src/start/StartPage.css
Move `.start-page`, `.topbar`, `.topbar-actions`, `.brand`, `.status`, `.settings-trigger` (+`:hover`), `.intro`, `.lede`, `.game-list`, `.game-row` family, `.preview` family, plus the start-page pieces of the 720px / 721-600 / landscape-600 media blocks (including `.intro-copy`, media `h1`, media `.brand-mark`). Import `./StartPage.css` in `StartPage.tsx`. Validate + checkpoint.

### Step 3 — src/credits/CreditsPage.css
Move `.credits-page`, `.credits-header`, `.credits-content` (+` h1`), `.credits-description`, `.credits-list`, `.credit-row` family, `.credit-stack > div`, plus the credits pieces of the 720px block. Import in `CreditsPage.tsx`. Validate + checkpoint.

### Step 4 — src/settings/SettingsModal.css
Move `.settings-backdrop`, `.settings-modal` (+` h2`), `.settings-close` (+`:hover`), `.setting-control` family, `.setting-label`, `.music-toggle`, `@keyframes fade-in`, `@keyframes modal-in`. Import in `SettingsModal.tsx`. Validate + checkpoint.

### Step 5 — src/settings/ControllerSettings.css
Move `.keybind-row` family, `.keybind-row .reset-button`, and the 520px keybind media block. Import `./SettingsModal.css` AND `./ControllerSettings.css` in `ControllerSettings.tsx` (reuses settings primitives). Validate + checkpoint.

### Step 6 — src/games/bubble-trouble/HighscoreTable.css
Move ONLY the base table rules: `.highscore-table`, `.highscore-table-head`, `.highscore-row`, `.highscore-row strong`, `.no-scores`. Game-context overrides (`.bubble-panel .highscore-table`, 520px `.bubble-result-panel .highscore-table*`) stay in the game CSS. Import in `HighscoreTable.tsx`. Validate + checkpoint.

### Step 7 — src/games/bubble-trouble/BubbleTroubleGame.css
Move all remaining `.bubble-*`, `.tutorial-*`, `.mobile-*`, `.loading-orb`, `.score-display`, `.name-field`, `.saved-note`, `.result-next-button`, `@keyframes spin`, `.bubble-panel .highscore-table`, and all remaining media blocks (720px page/shell, 720px hud, 721-600 game, landscape-600 game, 520px game). Import in `BubbleTroubleGame.tsx`. Validate + checkpoint.

### Step 8 — Remove src/App.css
Delete `src/App.css`; remove `import './App.css'` from `src/App.tsx`. Confirm no `App.css` references remain under `src/`. Validate + checkpoint.

### Step 9 — Codify the rule (01-flash-game-builder.md + agent mirror)
Add constraints and a `## Styling Workflow` section to `.clinerules/01-flash-game-builder.md` and `.github/agents/flash-game-builder.agent.md`:
- One co-located `<Component>.css` per component; no central global App stylesheet.
- Only global element/base rules plus shared primitives live in `src/index.css`.
- Reuse another component's primitives only by importing its stylesheet; never re-declare.
- Media queries and scoped overrides live in the owning component's CSS so cascade order never depends on import order.
- Check existing per-component CSS before adding rules; run the narrowest build/lint.

Validate + checkpoint.

### Step 10 — Consistency sync (skills + terminal rules)
- Add a "per-component CSS" Procedure step + Quality Gate to `.clinerules/skills/new-game-project/SKILL.md` and the mirror `.github/skills/new-game-project/SKILL.md`.
- Update `.clinerules/04-terminal-commands.md` examples that reference `src/App.css` to use `src/start/StartPage.css`.

Validate + checkpoint.

### Step 11 — Final validation
- `npm run build` passes; no `App.css` references under `src/`; every component imports its own CSS.
- Spot-check the start page, credits, settings, and bubble-trouble views.
- Lint is finalized in Step 12 (the findings predate this plan and are unrelated to the CSS refactor).

### Step 12 — Fix pre-existing lint findings
Make `npm run lint` exit 0 by resolving the findings that predate this plan (confirmed identical on pristine `HEAD`):
- Fix the blocking `react-hooks(rules-of-hooks)` error in `BubbleTroubleGame.tsx` — `useTranslations` is called conditionally behind `providedTranslations ??`.
- Resolve the remaining warnings where safe: `react(set-state-in-effect)` + `react-hooks(exhaustive-deps)` in `BubbleTroubleGame.tsx`, and `react(only-export-components)` in `ControllerSettings.tsx` (may require moving exported helpers to a non-component module and updating `src/settings/index.ts` re-exports).

Validate + checkpoint (both `npm run build` and `npm run lint` must be green).

## Class → file ownership map

| File | Rules it owns |
| --- | --- |
| `src/index.css` | `#root`, `.brand-mark`, `.text-button`, `.eyebrow`, `h1`, `h1 em` (global base) |
| `src/start/StartPage.css` | `.start-page .topbar .topbar-actions .brand .status .settings-trigger .intro .intro-copy .lede .game-list .game-row .preview .preview-label` + start media |
| `src/credits/CreditsPage.css` | `.credits-page .credits-header .credits-content .credits-description .credits-list .credit-row .credit-stack` + credits media |
| `src/settings/SettingsModal.css` | `.settings-backdrop .settings-modal .settings-close .setting-control .setting-label .music-toggle` + fade-in / modal-in |
| `src/settings/ControllerSettings.css` | `.keybind-row .reset-button` + 520px keybind media |
| `src/games/bubble-trouble/HighscoreTable.css` | `.highscore-table .highscore-table-head .highscore-row .no-scores` (base only) |
| `src/games/bubble-trouble/BubbleTroubleGame.css` | `.bubble-* .tutorial-* .mobile-* .loading-orb .score-display .name-field .saved-note .result-next-button` + spin + all game media |

## Out of scope

- CSS Modules / hashed class names (larger refactor, separate plan).
- `.github/diagram/*` — verified to have no CSS references; no diagram changes needed.

## Completion report

For each step: files changed, player-facing behavior (must be unchanged — visual no-op), and validation commands + results. The final report lists the full file set.