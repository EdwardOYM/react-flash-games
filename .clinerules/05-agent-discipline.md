# Agent Discipline — Plan & Mode Contract

This project is built checkpoint by checkpoint from a saved plan under `.clinerules/plans/<id>/<id>-plan.md`.
Any agent working in this repo (plan-mode helper or act-mode implementer) must honor the contract below
before reading code, asking questions, editing files, or running commands.

## Mode check (every turn)

1. Determine the current interaction mode from the user's message before doing anything else.
   - `plan` mode (plan-mode constraints apply): you may explore, read, search, analyze, and propose, but
     you may **not** make edits or run state-changing commands. Ask before changing anything.
   - `act` / `yolo` mode: implementation is allowed, but still follow the plan and checkpoint protocol
     below.
2. If the mode is ambiguous or you are resuming after context compaction, **re-read the active plan**
   (see "Plan check" below) to recover state instead of trusting a prior summary.
3. Never silently switch from plan mode to act mode. A mode change is signaled by the user's newest
   message, not by your assumption.

## Plan check (every turn)

1. Before implementing or modifying any feature that has a plan under `.clinerules/plans/`, read the
   relevant `plan.md` and locate:
   - the **Progress** checklist, and
   - the next incomplete checkpoint / sub-step.
2. Align your next action to that plan state. If the plan marks a checkpoint done, do not redo or redo
   it differently without an explicit reason recorded in the plan.
3. If a feature has no plan yet, say so plainly and proceed only after the user confirms, or ask for the
   missing inputs (for example a game name or core gameplay loop) before scaffolding.
4. Record plan status changes in the plan file itself — never claim a checkpoint complete in a message
   unless the corresponding `plan.md` Progress line is also updated and the checkpoint passed validation.

## Checkpoint protocol (when a plan defines one)

- Run **one checkpoint per session turn**.
- After each checkpoint, run the narrowest relevant validation (`npm run build` and/or `npm run lint`)
  and report the result explicitly.
- Then **stop**. Do not start the next checkpoint until the user replies "next" (or equivalent).
- If interrupted, re-read the plan, confirm the last completed step in Progress, and continue from there.

## Tool-use discipline (always)

- Read a file before editing it; do not guess its contents from memory or a stale summary.
- When editing, match `old_text` exactly (the file's current text, not a version you recall). If you are
  unsure of the exact text, re-read the file first.
- Make one precise edit per call when regions differ; do not bundle unrelated replacements into one call.
- Prefer `read_files` over terminal `Get-Content`/`type`, and `search_codebase` over `Select-String`/`findstr`.
- Prefer `read_files`/`search_codebase` for inspection over shell commands that page or prompt.
- Run the narrowest relevant validation after edits and report the command and its result.
- Use absolute paths when referring to files.
- Do not run interactive pagers, editors, dev servers, or prompting commands (see `.clinerules/04-terminal-commands.md`).

## Question discipline

- When you need a decision from the user, ask **one** question with 2–5 selectable options.
- Never include an option that toggles the user into act mode.
- State what you would do in each branch so the user can choose on the basis of the real tradeoff.

## Resumption discipline (after compaction)

- If prior context was compacted, treat any prior "done" claim for a checkpoint as unverified until you
  re-read the plan and the affected files.
- Re-derive current state from the plan's Progress line and the actual files on disk, not from a
  summarized turn log.

## Local conventions this rule leans on

- Project standards: `.clinerules/01-flash-game-builder.md`
- Diagram & flow checks: `.clinerules/02-diagram-flow-checks.md`
- Skills: `.clinerules/03-skills.md`
- Terminal commands (non-interactive PowerShell): `.clinerules/04-terminal-commands.md`
- Agent role definition: `.github/agents/flash-game-builder.agent.md`
- Plans: `.clinerules/plans/<id>/<id>-plan.md`
- Skills: `.clinerules/skills/<id>/<id>.md`
