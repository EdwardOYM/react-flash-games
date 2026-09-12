# Plan - Tron (2-player light-cycle game)

## Goal

Build Tron as the second playable game on this site: a top-down, up-to-2-player local "light cycle" arena game where each player moves forward at constant speed, turns 90 degrees at grid points, and paints a solid wall trail. Hitting the arena edge or any wall loses; a head-on head collision is a tie; the first player to win N rounds wins the match. The game page exposes a rounds-to-win setting (default 5) and per-player colors, mobile offers one analog stick per player, and the architecture leaves seams for a future Player-vs-Bot mode with easy/medium/hard bot difficulty. This plan fulfills the Tron entry in `.clinerules/goals/01-game-plan/goal.md`.

## Why a checkpoint protocol

A previous session in this repository died mid-execution (SocketError) while a large plan ran in one burst. The repo now standardizes on small numbered steps, one per session turn, with a build/lint checkpoint after every step (see `.clinerules/plans/01-decompose-css-plan/plan.md`).

## Checkpoint workflow

1. Run ONE step per session turn.
2. After each step run `npm run build` and `npm run lint`, report results, then STOP.
3. Do not start the next step until the user replies with "next".
4. Keep shell commands small, non-interactive, and end each with a `---done---` sentinel.
5. If interrupted, read this file, confirm the last completed step in Progress, and continue from there.

## Progress

- [x] Step 1 - Folders + config seed
- [x] Step 2 - Translation dictionaries + type unions
- [x] Step 3 - Game core module
- [x] Step 4 - Skeleton component + registry + StartPage branch
- [x] Step 5 - Desktop gameplay (canvas loop, input, HUD, round overlay)
- [x] Step 6 - Match setup UI (rounds + colors)
- [x] Step 7 - Mobile controls + remap flow
- [ ] Step 8 - Tutorial flow
- [ ] Step 9 - Victory / gameover / highscore + shared HighscoreTable
- [ ] Step 10 - Settings wiring + generic music labels
- [ ] Step 11 - Bot architecture seams (future scope)
- [ ] Step 12 - Responsive pass (960x540 / portrait / mobile landscape)
- [ ] Step 13 - Credits entry check
- [ ] Step 14 - Diagrams in sync
- [ ] Step 15 - Final validation

## Hard rules for every step

- Follow `.clinerules/01-flash-game-builder.md`: no player-facing literal strings in JSX or game metadata - every string routes through `t()` with keys added to en/ms/zh before use; one co-located `<Component>.css` per component; reuse primitives only by importing the owning stylesheet; never re-declare rules; cap layouts at `min(100%, 960px)`; conform to the 960x540 embed scale; add the mobile-landscape `@media (orientation: landscape) and (max-height: 600px)` pattern.
- Follow `.clinerules/02-diagram-flow-checks.md`: keep the single `flash-games.config` storage key; all config I/O through `src/config/index.ts`; keep the documented view state machine (start / tutorial / loading / playing / paused / remap / gameover / victory / highscore) - the round-end screen is an OVERLAY sub-state of `playing`, not a new view; update `.github/diagram/*` when wiring changes.
- Per-match options (rounds-to-win, colors) and any future bot mode are session state only - do NOT change the AppConfig schema.
- Game logic stays UI-free (`game-core.ts` has no React/canvas imports) so the future bot can drive it.
- The build must be green after every step; pre-existing lint findings are handled in Step 15 if still present.
- Tron source lives in `src/games/tron/`; media lives in `src/assets/tron/`.

## Design constants (agreed defaults)

| Constant | Value |
| --- | --- |
| Canvas | 960 x 540 (16:9) |
| Grid | 64 cols x 36 rows, CELL = 15 px |
| Tick | ~90-120 ms (~8-11 cells/s), interpolated rendering, 1 buffered turn |
| roundsToWin | 5 (stepper range 1-9) |
| Player colors | P1 #22d3ee (cyan), P2 #fb7185 (rose) - cycle body + trail + HUD via CSS vars `--tron-p1` / `--tron-p2` |
| Spawns | P1 left edge center facing right; P2 right edge center facing left |
| Tie rule | both heads occupy the same grid cell on the same tick (or crash on the same tick) |
| Highscore | winning player name + score = rounds won in the match; `highscores['tron']`, top-10 desc |
| Mobile sticks | reuse `mobileControls.movement` (P1, left) and `shoot` (P2, right) slots for position/scale |

## Input and keys

- 8 remappable actions in the shared key-binding contract: `tron-p1-up/down/left/right` (W/S/A/D) and `tron-p2-up/down/left/right` (ArrowUp/Down/Left/Right), labeled via `keyNames.p1Up` .. `keyNames.p2Right`.
- Mobile: two 2D analog sticks (x+y) with a deadzone that map to one buffered turn per player.

## Steps (one per turn, checkpoint after each)

### Step 1 - Folders + config seed
Create `src/games/tron/` and `src/assets/tron/`; add `src/assets/tron/README.md` modeled on `src/assets/bubble-trouble/README.md`. Add `"tron": []` under `highscores` in `src/config/default.config.json`. No registry/locale changes. Validate + checkpoint.

### Step 2 - Translation dictionaries + type unions
Add `games.tron`, `gameInspiration.tron` ("Tron light-cycle genre (1982 film)"), `keyNames.p1Up/p1Down/p1Left/p1Right/p2Up/p2Down/p2Left/p2Right`, and the full `tron.*` group (see Translation key map) to `en.json`, `ms.json`, `zh.json` with identical shapes. Extend the `TranslationKey` union and the `readTranslation` group union (add `'tron'`) in `src/assets/languages/index.ts`. Validate: en/ms/zh key parity + build + lint.

### Step 3 - Game core module
Create `src/games/tron/game-core.ts` (pure logic, no React/canvas imports): grid occupancy array, cycle state (col/row/direction/path), `startRound()`, and `step()` that advances ticks, applies one buffered turn per player, paints trail walls, detects wall/edge collisions, detects head-on ties, returns round results, and tracks match progress against `roundsToWin`. Export the types the component needs. Validate + checkpoint.

### Step 4 - Skeleton component + registry + StartPage branch
Create `src/games/tron/TronGame.tsx` (start view: title, description, menu buttons rendered through `t()`) and import `./TronGame.css` (skeleton). Extend `GameDefinition` unions, register Tron (`page: 'tron'`), and export `TronGame` in `src/games/index.ts`. Add the `selectedGame === 'tron'` branch in `src/start/StartPage.tsx`. Validate: the hub shows Tron and opens its start view + lint.

### Step 5 - Desktop gameplay (canvas loop, input, HUD, round overlay)
Implement `loading` -> `playing` on the Tron page: canvas rAF loop at 960x540 rendering trail walls and cycles in player colors; `keydown` / `keyup` for the 8 bindings; tick stepping through `game-core.step()`; HUD with round number, P1/P2 wins, ties, pause button, and key hints; round-over overlay (winner / tie banner + Continue) as a sub-state of `playing`; match-end detection when a player reaches roundsToWin. Validate + checkpoint.

### Step 6 - Match setup UI (rounds + colors)
Add to the Tron start view: rounds-to-win stepper (1-9, default 5) and P1/P2 color inputs (type=color). Session state only. Colors drive the canvas cycle/trail colors and `--tron-p1` / `--tron-p2`. Validate + checkpoint.

### Step 7 - Mobile controls + remap flow
Add two 2D analog sticks (left = P1, right = P2) with deadzone-based buffered turns, `touch-action: none`, and capability-driven visibility (`useControllerVisibility`). Persist position/scale through the existing `settings.mobileControls` slots (`movement` = P1 stick, `shoot` = P2 stick). Wire pause -> Controls -> ControllerSettings with `onRemapController`; stick reposition/resize only in remap; Save / Exit-without-saving. Validate + checkpoint.

### Step 8 - Tutorial flow
Add the `tutorial` view: guided goal-based steps (turn left, turn right, drive a wall safely, complete) with skip and finish; P2 parked safely during the tutorial. Reuse the tutorial-goal pattern from Bubble Trouble (no hardcoded copy). Validate + checkpoint.

### Step 9 - Victory / gameover / highscore + shared HighscoreTable
Extract `src/games/bubble-trouble/HighscoreTable.tsx` (+ its CSS) into `src/games/highscore/` and refactor Bubble Trouble to import it (visual no-op). Add `src/games/tron/highscores.ts` (read/save via config). Implement result views: `victory` (winner banner) and `gameover` (reached by forfeiting from pause via "End match"); both lead to `highscore` with a player-name input, save -> start, retry, and back-to-start. Validate + checkpoint.

### Step 10 - Settings wiring + generic music labels
Pass the 8 Tron keybindings to `SettingsModal` / `ControllerSettings` from the Tron start view; promote the shared modal's hardcoded Bubble labels (`bubble.settings`, `bubble.musicOn`, `bubble.musicOff`) to generic top-level keys and update Bubble Trouble to match; the music toggle persists `settings.music`. Keyboard remap stays hidden on mobile (existing behavior). Validate + checkpoint.

### Step 11 - Bot architecture seams (future scope)
Create `src/games/tron/bots.ts`: `TurnCommand`, `TurnSource` union (Human | Bot), `BotController` interface, and `createBot(difficulty: 'easy' | 'medium' | 'hard')` factories with documented strategies (easy = short random avoidance, medium = bounded lookahead, hard = flood-fill space scoring). `game-core` already consumes `TurnSource`, so core code is unchanged when a slot becomes a bot on the same device. No UI in this step - PvBot pickers are a future extension. Validate + checkpoint.

### Step 12 - Responsive pass
Verify every Tron view at 960x540, narrow portrait (<= 520px), and mobile landscape (`@media (orientation: landscape) and (max-height: 600px)`): 16:9 stage, `min(100%, 960px)` caps, fixed `100dvh` layout with safe-area insets and stage `height: min(calc(100dvh - 70px), calc(100vw * .5625))`, both sticks reachable and uncovered, no horizontal scrolling. Adjust only in `TronGame.css`. Validate + checkpoint.

### Step 13 - Credits entry check
Confirm the Credits page renders the Tron entry via the registry (`gameInspiration.tron`); adjust dictionary wording if needed. Validate + checkpoint.

### Step 14 - Diagrams in sync
Update `.github/diagram/database-schema.md` (GAME_CATALOG ids, highscores bucket example, source-references row) and `.github/diagram/architecture-flow.md` (registry -> tron node, Tron runtime subgraph with game-core / bots seam / highscores, note that round-over is an overlay sub-state of `playing`, persistence call-site row for `highscores['tron']`). Follow the GitHub-compatible Mermaid rules. Validate + checkpoint.

### Step 15 - Final validation
`npm run build` and `npm run lint` green; en/ms/zh key parity; every view reachable/leaveable (start / tutorial / loading / playing / paused / remap / gameover / victory / highscore); highscore save returns to start and refreshes the table; rounds + color settings affect gameplay; both sticks work on touch; three-viewport check; grep for player-facing literals in `src/games/tron/` and `src/games/index.ts`.

## Translation key map

- `games.tron`, `gameInspiration.tron`
- `keyNames.p1Up`, `keyNames.p1Down`, `keyNames.p1Left`, `keyNames.p1Right`, `keyNames.p2Up`, `keyNames.p2Down`, `keyNames.p2Left`, `keyNames.p2Right`
- `tron.*`: title, description, startMatch, tutorial, tutorialTitle, tutorialTurnLeft, tutorialTurnRight, tutorialWall, tutorialComplete, tutorialSkip, finish, settings, controls, back, exit, loading, playing, paused, pause, resume, round, rounds, firstTo, roundWonBy, roundTie, p1, p2, ties, victory, gameOver, endMatch, highscore, score, rank, noScores, playerName, defaultPlayerName, namePlaceholder, submitScore, scoreSaved, retry, backToStart, roundsToWin, playerColor, player1Color, player2Color, mobileP1Stick, mobileP2Stick, gameBoardLabel, inspiredBy

## File / module ownership map

| Path | Responsibility |
| --- | --- |
| `src/games/tron/game-core.ts` | pure grid / cycle / collision / round / match logic |
| `src/games/tron/TronGame.tsx` | views + canvas loop + input + HUD + mobile sticks |
| `src/games/tron/TronGame.css` | all Tron styling + media queries (single definition) |
| `src/games/tron/bots.ts` | bot seams: TurnSource / BotController / createBot stubs |
| `src/games/tron/highscores.ts` | read/save `highscores['tron']` via config |
| `src/games/highscore/HighscoreTable.tsx/.css` | shared table extracted from bubble-trouble |
| `src/assets/tron/README.md` | media placeholder |
| `src/config/default.config.json` | seed `highscores.tron = []` (only change) |
| `src/games/index.ts` | registry entry + `TronGame` export |
| `src/start/StartPage.tsx` | routing branch |
| `src/assets/languages/*.json` + `index.ts` | Tron keys + type unions |
| `src/settings/SettingsModal.tsx` | generic music label keys (shared refactor) |
| `.github/diagram/*.md` | schema + architecture flow sync |

## Out of scope

- Actual bot strategies and the Player-vs-Bot start-page pickers (future extension; Step 11 only lays the seams).
- Persisting rounds-to-win / colors / bot mode in the AppConfig schema (session-only by design; revisit only on request).
- Audio/SFX/music assets and Three.js models for the cycles (future; the asset folder is already reserved).
- Highscore metric alternatives (match-time ranking with ascending sort, cumulative wins per name) - v1 stores winner + rounds won.
- Achievements, profiles, or stats pages.

## Completion report

For each step: files changed, player-facing behavior, and validation commands + results. The final report closes this plan with the full file set and a summary following the Output section of `.clinerules/01-flash-game-builder.md`: files changed, player-facing behavior + credit entries, and the validation command + result.
