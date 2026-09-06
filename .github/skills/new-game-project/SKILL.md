---
name: new-game-project
description: 'Create a new React and Three.js flash game in this repository. Use when adding a game, scaffolding a new game folder, creating game assets and logic, registering a game page, or implementing the required start, tutorial, settings, gameplay, game-over, victory, and highscore flow.'
argument-hint: 'Provide the new game name and describe its core gameplay loop'
user-invocable: true
---

# New Game Project

## Purpose

Create a complete, independently organized game feature while preserving this repository's React, TypeScript, Three.js, translation, and reusable-settings conventions.

## Required Inputs

Before editing, identify:

- The game name and a filesystem-safe game id in lowercase kebab-case.
- The core gameplay loop and win/loss condition.
- The player actions that need key bindings.
- Any images, models, textures, audio, or other assets needed.
- The default highscore behavior and score calculation.
- The game's inspiration and the credit/source name to display for it.
- The default configuration values and config namespace for settings and highscores.

If the game name or core loop is missing, ask for those details before creating folders.

## Responsive and Input Requirements

Every page and state must be usable on mobile and desktop, including start, tutorial, loading, gameplay, pause, game-over, victory, highscore, settings, and credits views.

- Design for portrait and landscape mobile layouts. Prevent horizontal overflow and keep panels, forms, tables, buttons, canvas elements, and overlays inside the available safe area.
- Test narrow portrait dimensions and short landscape dimensions. Do not rely only on a `max-width` media query when the game can be embedded in a fixed-size iframe.
- Use a reusable virtual gamepad/controller for mobile input. Keep movement controls touch-friendly, support horizontal-only sticks when the game only needs left/right movement, and keep action controls reachable without covering important game content.
- Allow mobile controller placement to be adjusted only through an explicit settings/remap flow. Do not show drag handles during normal gameplay or pause; provide Save and Exit without saving for temporary placement changes.
- Use keyboard key bindings and remapping on desktop. Keep gameplay actions in the shared key-binding contract so each game can provide its own translated action list.
- Determine the active input mode from capabilities and input activity, such as touch points/coarse pointer, `gamepadconnected`, and keyboard events. Do not use user-agent strings or viewport width as the sole device or input-mode detector.
- Make controller visibility capability-driven so mobile controls still appear inside fixed embeds such as itch.io frames.
- Hide desktop keyboard-remapping controls on mobile, and hide mobile controller-placement controls on desktop unless a connected gamepad explicitly requires them.

## Folder Contract

For a game named `Example Game` with id `example-game`, create both folders:

- `src/games/example-game/` for React pages, game state, gameplay logic, types, and local components.
- `src/assets/example-game/` for images, models, textures, audio, fonts, and other game media.

Keep game-specific files inside those folders. Shared utilities belong in an existing shared module only when they are genuinely reused by multiple games.

## Procedure

1. Inspect nearby implementations, `src/games/index.ts`, `src/settings/`, `src/assets/languages/`, and the current routing or page composition.
2. Form a local implementation plan covering the game id, page entry point, state transitions, assets, translation keys, and key bindings.
3. Create the game and asset folders before adding implementation files. Add or extend the default `.config` file and config store for the game's settings and highscores.
4. Create a game start page with:
   - Start game button.
   - Help/Tutorial button.
   - Tutorial slideshow with next, previous, and close or finish controls.
   - Settings button that opens the reusable settings component from `src/settings/`.
   - Music toggle button, persisted with the game's settings behavior.
   - Exit button that returns to the main start page.
5. Create the gameplay page with explicit states for:
   - Loading.
   - Active gameplay.
   - Paused gameplay with a pause/resume control.
   - Game over.
   - Victory, which transitions to the highscore page.
6. Create the highscore page with:
   - Score display.
   - Player name input when the game ends.
   - Persistent highscore storage in the shared config store, plus the requested `.txt` representation through an explicit download/export or an existing backend. Do not scatter settings or highscores across unrelated storage keys.
   - Return to game start and retry controls. After a successful save, return automatically to the game start page so the updated highscore list is immediately visible.
7. Add every player-facing string to `src/assets/languages/en.json`, `ms.json`, and `zh.json` using identical key shapes.
8. Render all copy through the existing translation method. Never hardcode visible text, button labels, status text, tutorial text, aria labels, or error messages in JSX or game definitions.
9. Represent game names, actions, status labels, and inspiration credits in metadata as translation keys, not localized strings.
10. Add the game's inspiration source to the credits page under the “Game inspired by” section. If the game is an original concept, record that explicitly; do not omit the credit.
11. Add every new gameplay action to the reusable settings/key-remapping contract so players can remap it. Music controls must also use translated labels.
12. Register the game in `src/games/index.ts` with its id, translation keys, status, inspiration credit, and page/component entry point. Ensure the main game list opens the new game page instead of only displaying metadata.
13. Keep Three.js setup and cleanup local to the game. Dispose geometries, materials, textures, renderers, listeners, and animation frames during unmount or state teardown.
14. Add or update focused tests when the game has non-trivial state transitions, scoring, persistence, or input mapping.
15. Run the narrowest relevant validation after each implementation slice, then run the production build and locale-shape validation.
16. Validate every page and state at mobile portrait, mobile landscape, and desktop dimensions. Confirm that fixed-size embeds do not hide capability-driven mobile controls.

## Quality Gates

Before finishing, verify:

- The game can enter and leave every required page/state without a dead end.
- Loading, pause, game over, victory, retry, exit, and highscore paths are reachable.
- Saving a highscore returns to the game start page and shows the updated leaderboard.
- Tutorial navigation works and does not require hardcoded copy.
- All pages remain usable without horizontal overflow at narrow portrait and short landscape dimensions.
- Mobile devices expose a usable virtual gamepad/controller, including in fixed-size embeds, while desktop devices expose keyboard key bindings.
- Input mode detection uses touch/gamepad/keyboard capabilities and activity rather than user-agent strings alone.
- Mobile controller placement is locked during normal play and can be changed only through the explicit remap, Save, and Exit flow.
- Desktop settings show keyboard remapping; mobile settings do not show keyboard remapping.
- Settings opens from the game start page and includes all new keybind actions.
- Volume/music and highscore persistence do not crash when storage is unavailable or empty.
- Default settings and highscores are represented in the project `.config` file, with browser persistence using the shared config store.
- All three locale dictionaries contain matching keys for the new feature.
- The credits page includes the new game's inspiration/source entry.
- No player-facing literal strings remain in the new game UI or metadata.
- `npm run build` passes.
- Relevant diagnostics, tests, or lint checks pass; report any environment-only blockers.

## Optional Future Extensions

Do not add these unless requested, but leave clear extension points for:

- Achievements or trophies as a checklist of unlocked challenges.
- Profile or stats pages tracking play time, win/loss ratio, or game-specific metrics.

## Completion Summary

Report:

- The new game id and created folders.
- Pages and state transitions implemented.
- Translation keys and settings/keybind additions.
- Highscore and settings persistence behavior.
- Validation commands and results.
