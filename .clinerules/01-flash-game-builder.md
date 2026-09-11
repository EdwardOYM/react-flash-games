# Flash Game Builder — Project Standards

This project is a React + Three.js flash-games website. You are building this project on behalf of the "Flash Game Builder" agent role (defined in `.github/agents/flash-game-builder.agent.md`). Follow these standards for every change.

## Responsibilities

- Build start-page UI in `src/start/`.
- Add individual games and shared game contracts in `src/games/`.
- Organize images, textures, audio, and other media in `src/assets/`.
- Use the language dictionaries in `src/assets/languages/` for every player-facing string.
- Preserve the existing Vite, React, TypeScript, and Three.js setup.

## Constraints

- Keep game logic isolated from the start-page shell.
- Prefer small, composable React components and dispose Three.js resources in effect cleanup.
- Do not introduce a new framework or move the requested folder boundaries without a clear need.
- Never hardcode player-facing text in JSX, game definitions, buttons, labels, aria-labels, status text, or error messages.
- Render copy through the project's translation method, using keys such as `t('games.orbit')` rather than literal strings.
- When adding copy, add the same key to `src/assets/languages/en.json`, `src/assets/languages/ms.json`, and `src/assets/languages/zh.json` before consuming it.
- Store translation keys in game metadata; do not store localized display text in `src/games/`.
- Keep technical identifiers, CSS classes, route paths, and Three.js values out of the translation dictionaries.
- One co-located `<Component>.css` per component; no central global `App.css`.
- Reuse another component's primitives only by importing its stylesheet; never re-declare.
- Run the narrowest relevant build, lint, or test command after edits.
- Keep in mind sound effects, music, and other media may be added in future to certain components such as buttons and gameplay mechanics. Add inspiration/source credits to the credits page.
- Keep controls and key bindings consistent with the existing settings contract, and add new actions to the contract for remapping. Controls have desktop and mobile variants. Music controls must also use translated labels.

- Conform every page and view (start page, game pages, menus, and overlays) to the shared `960x540` (16:9) embed scale. Author the game stage and canvas at 960x540, cap layouts and the stage with `min(100%, 960px)`, and scale down for smaller embeds. `960x540` is the recommended embed size (for example itch.io); no page may require horizontal scrolling.
- Handle mobile viewports in landscape mode with the shared `@media (orientation: landscape) and (max-height: 600px)` pattern: switch the page to a fixed full-viewport layout (`height: 100dvh; min-height: 0; overflow: hidden`), pad with safe-area insets (`env(safe-area-inset-*)`), and fit the 16:9 stage to the shorter viewport dimension, for example `height: min(calc(100dvh - 70px), calc(100vw * .5625))`, so the HUD, stage, and mobile controls stay visible without scrolling.

## Localization Workflow

1. Check the existing locale keys before adding new copy.
2. Add or update the key in all three locale dictionaries.
3. Use the translation method in React components and pass translated strings to accessible labels.
4. Verify that locale dictionaries have matching key shapes.

## Styling Workflow

- One co-located `<Component>.css` per component; no central global App stylesheet.
- Only global element/base rules plus shared primitives live in `src/index.css`.
- Reuse another component's primitives only by importing its stylesheet; never re-declare.
- Media queries and scoped overrides live in the owning component's CSS so cascade order never depends on import order.
- Conform every page to the `960x540` (16:9) embed scale: give the game stage and canvas `aspect-ratio: 16 / 9`, cap component widths at the embed width with `min(100%, 960px)`, and let heights, spacing, and type shrink with `min()`/`clamp()` instead of a fixed desktop layout.
- Add a mobile-landscape breakpoint in the owning component CSS (`@media (orientation: landscape) and (max-height: 600px)`) that locks the page to `100dvh`, hides overflow, applies `env(safe-area-inset-*)` padding, and sizes the stage to the shorter dimension, for example `height: min(calc(100dvh - 70px), calc(100vw * .5625))`.
- Validate every page and state at the `960x540` reference embed, at narrow portrait (up to 520px), and at mobile landscape before finishing.
- Check existing per-component CSS before adding rules; run the narrowest build/lint.

## Output

When finishing a task, summarize:

- The files changed.
- The player-facing behavior (and credit entries when media/inspiration was added).
- The validation command and its result.