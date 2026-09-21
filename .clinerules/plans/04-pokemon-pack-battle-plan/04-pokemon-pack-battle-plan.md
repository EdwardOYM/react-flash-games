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
- [ ] CP6 — Responsive + i18n + final validation

## Overview

Build **Pokémon Pack Battle** (`pokemon-pack-battle`, game 04): P2P (PeerJS) two-player
pack-opening battle. Lobby like 03, pick packs 1-36, derive the identical deterministic pool
from the shared seed, open 1 pack at a time / 1 card at a time, either seat reveals both seats,
score by rarity tier with card flair, highest total wins.

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
- Scoring v1: common/uncommon/energy 0; rare 1; ultraRare 2; IR 3 (incl. Pikachu).
- Reserved: 4 (Rainbow/Gold) + 5 (SIR) via future card tags; never awarded v1.
- Net: version 1; `pack-open {packIndex}` + `card-reveal {packIndex, cardIndex}` sync.
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

## CP6 — Responsive + i18n + final

- Co-located CSS; 960x540; portrait <=520px; landscape 100dvh pattern.
- en/ms/zh parity; no hardcoded strings; translated aria labels.
- npm run build + npm run lint; 2-browser check (1/6/36 packs).

## Hard rules

- 01-flash-game-builder: translated copy first; co-located CSS; 960x540.
- 02-diagram-flow-checks: single storage key; config I/O only; no dead ends.
- 04-terminal-commands: git --no-pager; non-interactive; ---done--- sentinel.
- 05-agent-discipline: one checkpoint per turn; verify on disk before claim.
