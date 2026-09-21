# Implementation Plan — Pokémon Pack Battle (04)

> **Checkpoint protocol** (from `02-tron-game-plan.md` + `05-agent-discipline.md`): run ONE
> checkpoint per session turn. After each checkpoint run `npm run build` (+ lint where relevant),
> report results, then STOP. Do not start the next checkpoint until the user replies "next".

## Progress

- [x] CP0 — Pure core scaffold (unregistered): scoring, protocol fork, battlePack, highscores
- [x] CP1 — Registry + config seed + diagrams
- [x] CP2 — Start / tutorial / settings shell
- [x] CP3 — Lobby flow (PeerJS, packs 1-36, seed broadcast)
- [x] CP4 — Opening ceremony (1 pack/1 card, counter, synced reveal, flair + scoring)
- [x] CP5 — Results / highscore / credits
- [x] CP6 — Responsive + i18n + final validation
- [x] CP7 — Paired-pack ceremony (side-by-side per-seat packs, synced matching-card reveal)

## Overview

Build **Pokémon Pack Battle** (`pokemon-pack-battle`, game 04): P2P (PeerJS) two-player
pack-opening battle. Lobby like 03, pick packs 1-36, derive the identical deterministic pool
from the shared seed, open one pack per seat per round side by side and reveal the matching card
in both packs at once (either seat reveals both seats), score by rarity tier with card flair,
highest total wins.

Sources: `src/games/pokemon-pack-battle/`. Reuses 30c set data + TCGdex faces. No new assets.
Session-only lobby settings (never in `AppConfig`).

## Required inputs

- Name/id: Pokémon Pack Battle / `pokemon-pack-battle`
- Loop: lobby → packs → synced opening → score → results → highscore → retry/exit
- Win/loss: higher total wins; tie = draw (no sudden-death v1)
- Keybinds: `pokemon-pack-confirm` (open/reveal), `pokemon-pack-skip` (reveal pack)
- Highscore: `highscores['pokemon-pack-battle']` win tally, top-10 desc
- Credit: community "pack battle" format, key `gameInspiration.pokemonPackBattle`
- Config: no `AppConfig` shape change

## Design constants

- Packs 1-36 (default 6); 6 cards/pack.
- Slot order: energy, common, common, unique Pikachu, common-and-above, uncommon-and-above.
- Weights common+: common 62 / uncommon 8 / rare 21 / ultraRare 6 / IR 3.
- Weights uncommon+: uncommon 6 / rare 68 / ultraRare 17 / IR 9.
- Scoring v1: common/uncommon/energy 0; rare 1; ultraRare 2; IR 3 — but the
  pack-guaranteed Pikachu IR (`pikachu-ir`, present in every pack) scores 0.
- Reserved: 4 (Rainbow/Gold) + 5 (SIR) via future card tags; never awarded v1.
- Net: version 2; `pair-open {pairIndex}` + `card-reveal {pairIndex, cardIndex}` sync (one round
  = 2 packs = one per seat; `maxPairs` 18 bounds the wire index).
- Stage 960x540; `min(100%, 960px)`; mobile-landscape 100dvh pattern.

## CP0 — Done

- scoring.ts: tier/points/scorePack, ceiling 3.
- net/protocol.ts: limits 1-36/6, settings helpers, guard.
- battlePack.ts: PACK_BATTLE_30C 6-slot + weights.
- highscores.ts: win-tally mirror.
- Validation: `npm run build` passed (2.15s).

## CP1 — Registry + config + diagrams (next)

- games/index.ts: add definition (titleKey games.pokemonPackBattle).
- default.config.json: seed highscores bucket.
- StartPage.tsx: route to pack-battle entry.
- architecture-flow.md + database-schema.md: runtime + bucket rows.

## CP2 — Start / tutorial / settings shell

- Start/Help-Tutorial/Settings/music-toggle/Exit via SettingsModal.
- Tutorial slideshow next/previous/close-finish.
- Bindings pokemon-pack-confirm / pokemon-pack-skip.

## CP3 — Done

- Lobby mirrors 03 bnb exactly: start (server field + create/join) → host `lobby`
  (code row + copy, name, set + packs stepper 1-36, status dot, start) / guest
  `lobbyJoin` (name + code + server form) that steps into the shared lobby on
  `hello-ack`; host edits broadcast `lobby-update`; `lobby-start` carries the
  shared seed to the opening placeholder; `leave` returns to start from every view.
- LobbyView.tsx (CP2 tabs) replaced by LobbyFields.tsx (bnb LobbyFields pattern).
- Stable ref-closure message handler; auto-clear notices; translated errors;
  name re-announce on edit; guest redial replays hello-ack + lobby-update (+ lobby-start once seeded).
- i18n: 12 new packBattle keys in en/ms/zh (+ parametrized statusConnected); parity verified.
- Validation: `npm run build` ✓ (2.07s), `npm run lint` ✓ (0/0).

## CP3 — Lobby flow

- Host create + guest join (bnb peer pattern).
- Packs stepper 1-36 clamp/validate; lobby-update/start.
- Leave returns to start.


## CP4 — Done

- battlePack.ts engine: battleSetCards (shared 30c JSON, type-only CardDef reuse),
  openBattlePacks (PACK_BATTLE_30C slots: energy / common / common / pikachu-IR /
  common-or-better ladder / uncommon-or-better ladder, weighted, deterministic via
  pack-battle rng from the shared seed), seatForPack (parity deal: host even packs,
  guest odd; odd counts give the last pack to BOTH seats — no free-pack advantage).
- Shared cursor {packIndex, cardIndex, opened} synced by pack-open/card-reveal with
  max-merge; either seat reveals both; skip = reveal whole pack; packs-left counter
  top-right; 1 pack at a time, 1 card at a time.
- Score via pointsForCard per reveal; tier-0..5 flair classes (ppb-tier-*); +points
  chip; running seat totals panel; battle-done {score} sent once at completion.
- Face reuse: bnb PokemonCard (TCGdex faces + face-down back), no re-declared faces,
  no new assets; card token --pkm-card-w tuned per breakpoint (3x2 landscape, 2-col portrait).
- Remappable Confirm/Skip keys (pokemon-pack-confirm / pokemon-pack-skip) drive
  open / reveal / next-pack via the bnb ref-handler pattern.
- Re-dial hardening: host replays pack-open + card-reveal on re-hello (same-seed
  lobby-start no longer resets the guest cursor); inbound packIndex bounded by the
  locked pack count.
- i18n: 16 new packBattle keys in en/ms/zh; parity verified (78 keys).
- Validation: `npm run build` ✓ (2.11s), `npm run lint` ✓ (0/0).

## CP4 — Ceremony

- Precompute OpenedCard[] from shared seed; shared cursor pack/card.
- 1 pack at a time, 1 card at a time; packs-left counter top-right.
- Either seat open/reveal syncs both (max-merge cursor).
- Score via pointsForCard; tier flair tier-0..5 classes.

## CP5 — Done

- Ceremony completion routes both seats to `results`: victory (own seat) / defeat
  ({name} won) / draw from the shared totals, final score panels + seed line.
- recordPackBattleWin(winner) records once per device at completion (draw records
  nothing); the shared HighscoreTable view (results → highscore → back) lists the
  pokemon-pack-battle win tally.
- Rematch handshake on the results: guest offers (`rematch`), host accepts (or
  presses "Rematch with new packs" directly) — a fresh seed via the normal
  `lobby-start`; flags reset with the ceremony on both seats.
- Credits: already wired via the registry inspirationKey (CP1) — confirmed, no change.
- i18n: 9 new packBattle keys in en/ms/zh; parity verified (87 keys).
- Validation: `npm run build` ✓ (2.06s), `npm run lint` ✓ (0/0).

## CP5 — Results / highscore / credits

- victory/gameover/draw; rematch + retry + exit.
- Shared HighscoreTable; recordPackBattleWin once; save returns to start.
- Credits inspiration entry.

## CP6 — Done

- Responsive audit: 960x540 embed caps (min(100%, 960px) topbar/shells), landscape
  100dvh + safe-area pattern with contained internal shell scroll (overflow:hidden
  can never clip the actions), portrait <=520px stacked fields + touch targets,
  card token --pkm-card-w per breakpoint (base 6-col / landscape 3x2 / portrait 2-col),
  highscore table capped + contained in landscape.
- i18n audit: no hardcoded player-facing strings or untranslated aria-labels in the
  pack-battle files (scan verified); en/ms/zh parity 87 keys.
- Engine validated live (esbuild bundle + node, temp files removed): 1/6/36 packs —
  deterministic across runs, exact slot order (energy/common/common/pikachu-ir/
  common-or-better/uncommon-or-better), guaranteed-Pikachu exclusion elsewhere,
  seed divergence, even/odd seat splits via seatForPack.
- Validation: `npm run build` ✓ (1.99s), `npm run lint` ✓ (0/0), `PARITY-OK (87)`.
- Remaining manual QA (human): two-browser 2P run at 1/6/36 packs (join flow,
  synced reveal, rematch across devices).

## CP6 — Responsive + i18n + final

- Co-located CSS; 960x540; portrait <=520px; landscape 100dvh pattern.
- en/ms/zh parity; no hardcoded strings; translated aria labels.
- npm run build + npm run lint; 2-browser check (1/6/36 packs).

## CP7 — Done

- Paired packs (side-by-side): one round unseals **one pack per seat** — host's pack left,
  guest's pack right — and each reveal unseals the **matching card slot in both packs at once**
  (slot order is identical in every pack), so neither seat ever waits on the other's turn.
- battlePack.ts: `PACKS_PER_PAIR` (2), `pairCountForPacks(packCount)`, `packIndexesInPair(pairIndex,
  packCount)` — the trailing round of an odd pack count holds only that final pack, whose
  `seatForPack` owner is BOTH (no free-pack advantage).
- net/protocol.ts: version 2; `pack-open {packIndex}` → `pair-open {pairIndex}`,
  `card-reveal {pairIndex, cardIndex}`; `PACK_BATTLE_LIMITS.packsPerPair` 2 / `maxPairs` 18;
  `validPairIndex` guard replaces `validPackIndex`.
- Shared cursor `{pairIndex, cardIndex, opened}` with max-merge on receive; re-hello replay sends
  the current `pair-open` + last `card-reveal` so a redialled seat catches up; inbound round index
  bounded by `pairCountForPacks(settings.packs)`. Confirm/Skip keys drive open / reveal-next /
  reveal-both / next round unchanged.
- Scoring unchanged (either seat's reveal still scores for both) but now computed per pack:
  `packPointsRevealed(packIndex)` banks each pack's revealed cards, so the seat totals and the
  per-pack "+points" chip stay correct with both packs open at once.
- CSS: `.ppb-pair` 2-up grid (auto-collapses to one column for a lone pack / portrait), `.ppb-pack`
  seat panel with `.ppb-pack-owner` + `.ppb-pack-points`, six slots per pack as 3x2; sealed pack is
  now the pack's grid-spanning placeholder; landscape token `--pkm-card-w` shrink stays inside 100dvh.
- i18n: 3 new keys (`packOwner`, `bothRole`, `packPoints`); `packProgress` re-worded to
  round-based copy; `description` / `tutorialOpen` / `action*` updated in en/ms/zh (parity kept).
- Validation: `npm run build` ✓ (tsc -b + vite, 1.93s), `npm run lint` ✓ (0 warnings / 0 errors).

## CP8 — Done

- The pack-guaranteed Pikachu IR now scores **0** (was 3): every battle pack carries one
  (30 variants, `irVariation` 1-30) so it is a constant for both seats and cannot separate them.
- scoring.ts is identity-aware: `isGuaranteedPikachuIr(card)` (single shared definition;
  battlePack.ts's private duplicate was removed and imports it instead), plus
  `tierForCard(card)` / `pointsForCard(card)` / `scorePack(cards)` now take the card, so the
  guaranteed slot is tier 0 — no tier flair and no `+points` chip. `tierForRarity` stays the
  rarity ladder used by `tierForCard` (tiers 4/5 still reserved for future finish tags).
- No scoring leak in either direction: ladder IRs keep 3 points, and the weighted ladders
  already excluded the guaranteed pool, so a scored IR is never the guaranteed card.
- i18n: `packBattle.tutorialScore` re-worded in en/ms/zh to state the guaranteed Pikachu is 0
  (parity 90 keys in all three dictionaries; no other copy changed).
- Validation: `npm run build` ✓ (tsc -b + vite, 1.68s), `npm run lint` ✓ (0 warnings / 0 errors).
  Engine check (esbuild bundle + node, temp files removed): over 400 packs every one holds
  exactly one 0-point `pikachu-ir` slot, all other slots score per rarity, and no ladder IR
  resolves to the guaranteed pool.

## Hard rules

- 01-flash-game-builder: translated copy first; co-located CSS; 960x540.
- 02-diagram-flow-checks: single storage key; config I/O only; no dead ends.
- 04-terminal-commands: git --no-pager; non-interactive; ---done--- sentinel.
- 05-agent-discipline: one checkpoint per turn; verify on disk before claim.
