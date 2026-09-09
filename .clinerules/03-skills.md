# Skills

This workspace bundles Cline skills under `.clinerules/skills/`:

- `new-game-project` — create a complete new React + Three.js flash game: scaffold `src/games/<id>/` and `src/assets/<id>/`, implement the start, tutorial, loading, settings, gameplay, pause, game-over, victory, and highscore flow, and wire translations, key rebindings, config/highscore persistence, and credits.

The same skill is mirrored at `.github/skills/new-game-project/SKILL.md` (GitHub Copilot format) — keep both copies in sync. The agent definition lives at `.github/agents/flash-game-builder.agent.md` and provides the cross-tool version of the project rules.

## When to use skills

- Trigger the `new-game-project` skill (via the `/new-game-project` slash command or by matching its description) whenever the task involves:
  - Adding a new game or scaffolding a new game folder.
  - Implementing the full start, tutorial, settings, gameplay, pause, game-over, victory, or highscore flow.
  - Adding game assets, translations, key bindings, config namespaces, or highscore persistence for a game.
- Read the skill's `SKILL.md` before starting and follow its Required Inputs, Procedure, and Quality Gates.
- If the game name or its core gameplay loop is missing, ask for those details before creating folders.