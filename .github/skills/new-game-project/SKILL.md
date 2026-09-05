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

If the game name or core loop is missing, ask for those details before creating folders.

## Folder Contract

For a game named `Example Game` with id `example-game`, create both folders:

- `src/games/example-game/` for React pages, game state, gameplay logic, types, and local components.
- `src/assets/example-game/` for images, models, textures, audio, fonts, and other game media.

Keep game-specific files inside those folders. Shared utilities belong in an existing shared module only when they are genuinely reused by multiple games.

## Procedure

1. Inspect nearby implementations, `src/games/index.ts`, `src/settings/`, `src/assets/languages/`, and the current routing or page composition.
2. Form a local implementation plan covering the game id, page entry point, state transitions, assets, translation keys, and key bindings.
3. Create the game and asset folders before adding implementation files.
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
   - Persistent highscore storage in the requested `.txt` representation or the project's established storage boundary. In a browser-only app, use an explicit `.txt` download/export or an existing backend; do not claim that `localStorage` is a `.txt` file.
   - Return to game start and retry controls.
7. Add every player-facing string to `src/assets/languages/en.json`, `ms.json`, and `zh.json` using identical key shapes.
8. Render all copy through the existing translation method. Never hardcode visible text, button labels, status text, tutorial text, aria labels, or error messages in JSX or game definitions.
9. Represent game names, actions, and status labels in metadata as translation keys, not localized strings.
10. Add every new gameplay action to the reusable settings/key-remapping contract so players can remap it. Music controls must also use translated labels.
11. Register the game in `src/games/index.ts` with its id, translation keys, status, and page/component entry point. Ensure the main game list opens the new game page instead of only displaying metadata.
12. Keep Three.js setup and cleanup local to the game. Dispose geometries, materials, textures, renderers, listeners, and animation frames during unmount or state teardown.
13. Add or update focused tests when the game has non-trivial state transitions, scoring, persistence, or input mapping.
14. Run the narrowest relevant validation after each implementation slice, then run the production build and locale-shape validation.

## Quality Gates

Before finishing, verify:

- The game can enter and leave every required page/state without a dead end.
- Loading, pause, game over, victory, retry, exit, and highscore paths are reachable.
- Tutorial navigation works and does not require hardcoded copy.
- Settings opens from the game start page and includes all new keybind actions.
- Volume/music and highscore persistence do not crash when storage is unavailable or empty.
- All three locale dictionaries contain matching keys for the new feature.
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
