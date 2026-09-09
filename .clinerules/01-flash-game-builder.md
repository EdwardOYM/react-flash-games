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
- Run the narrowest relevant build, lint, or test command after edits.
- Keep in mind sound effects, music, and other media may be added in future to certain components such as buttons and gameplay mechanics. Add inspiration/source credits to the credits page.
- Keep controls and key bindings consistent with the existing settings contract, and add new actions to the contract for remapping. Controls have desktop and mobile variants. Music controls must also use translated labels.

## Localization Workflow

1. Check the existing locale keys before adding new copy.
2. Add or update the key in all three locale dictionaries.
3. Use the translation method in React components and pass translated strings to accessible labels.
4. Verify that locale dictionaries have matching key shapes.

## Output

When finishing a task, summarize:

- The files changed.
- The player-facing behavior (and credit entries when media/inspiration was added).
- The validation command and its result.