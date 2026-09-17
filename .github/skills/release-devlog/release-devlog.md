---
name: release-devlog
description: 'Create a short, player-friendly release devlog by comparing the latest two uploaded build versions of this game. Use when writing a devlog, release notes, or changelog, after uploading a new edward-flash-to-react-games version zip, or when asked to compare the latest 2 versions of the game.'
argument-hint: 'Optionally specify which two versions to compare, e.g. 0.9.3 vs 1.4.1'
user-invocable: true
---

# Release Devlog

## Purpose

Produce a short, easy-to-understand devlog for players by comparing the latest
two uploaded build versions in `uploaded versions/`. The devlog explains what
changed for players — new games, sounds, settings, screens — never build
numbers, bundle sizes, or implementation details.

## Required Inputs

Before writing, identify:

- The two versions to compare. Default to the **latest two** by parsing version
  numbers from the ZIP filenames in `uploaded versions/`
  (`edward-flash-to-react-games.<version>.zip`). If the user names specific
  versions, use those.
- The existing devlog template: `uploaded versions/devlog/devlog-<version>.md`
  from the previous release. Match its structure and tone.

If fewer than two version ZIPs exist, or the newest ZIP has no devlog template
to follow, fall back to this repository's header style: `# Devlog: Update
v<new-version>` with a `## What's new` section and emoji-led blocks.

## Comparison Method

Do not extract the ZIPs. Inspect them in memory with
`[System.IO.Compression.ZipFile]::OpenRead()` (the entries are built `dist/`
bundles with `index.html` at the ZIP root). Never modify or re-zip the uploads.

1. List entries and sizes from both ZIPs; classify each as identical,
   only-in-old, only-in-new, or changed.
2. New media files (`.mp3`, images, fonts) are player-relevant: note them as
   sounds or art the player will encounter.
3. For changed JS/CSS bundles, probe for player-relevant differences only:
   - Game registry entries (`{id, titleKey, statusKey}`) → new or updated games.
   - New CSS class roots and `@keyframes` → new screens, overlays, or animations.
   - Settings schema tokens (`musicVolume`, `sfx`, `sfxVolume`, `muted`,
     `mobileControls`, `keybindings`) → new settings or controls.
   - Locale and credit strings (`en` / `ms` / `zh`, inspiration credits) →
     new translations and credits the player can see.
   - New key-binding action ids → remappable actions added.
4. Ignore hashed filenames, minified internals, library code, and vendor
   tokens — they are invisible to players.

## Devlog Style

Follow the player-facing template — this is the required output shape:

- Header: `# Devlog: Update v<new-version>` (the new version only; mention the
  old version nowhere in the body).
- Section: `## What's new` containing emoji-led blocks, each a bold emoji line
  followed by a short bullet list:
  - `🎮` block for new games (name, how it plays, who you can play against).
  - `🔊` block for music and sound effects.
  - `✨` block for other player-visible improvements (settings, highscores,
    translations, saved data carrying over).
- Write for players: short bullets, plain words, no code, no file names, no
  bundle sizes, no version pairs, no "build" language.
- Keep it brief — roughly one page. Trim blocks that would have no bullets.

Save the result to `uploaded versions/devlog/devlog-<new-version>.md`. Never
overwrite or edit an existing devlog file; if one already exists for the
target version, show it and confirm before making any change.

## Procedure

1. List `uploaded versions/` and determine the latest two versions to compare.
2. Read the previous devlog to match the template, tone, and emoji blocks.
3. Compare the two ZIPs using the Comparison Method above.
4. Group the findings into player-visible changes: games, sounds, settings,
   highscores, controls, translations, credits, saved-data migration.
5. Write the devlog in the required style and save it as
   `uploaded versions/devlog/devlog-<new-version>.md`.
6. If nothing player-visible changed, write a two-bullet polish/maintenance
   note instead of inventing features — do not fabricate changes.
7. Validate: re-read the saved devlog and confirm it matches the template
   shape, uses plain player language, and contains no build jargon. This is a
   documentation-only change; no build or lint is required.

## Quality Gates

Before finishing, verify:

- The devlog covers the latest two uploaded versions (or the versions the user
  explicitly requested).
- Every claim traces back to an actual difference between the two ZIPs.
- The output follows the `# Devlog: Update v<new-version>` template with
  `## What's new` and emoji-led blocks.
- The tone is plain and player-facing: no code, no file names, no bundle
  sizes, no build numbers.
- The file is saved as `uploaded versions/devlog/devlog-<new-version>.md` and
  no existing devlog or uploaded ZIP was modified.

## Completion Summary

Report:

- The two versions compared and the devlog file created.
- The player-visible changes grouped by block (games, sounds, other).
- Any player-relevant finding omitted from the devlog and why (for example,
  it is too technical or too niche for players).