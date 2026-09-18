# Implementation Plan — Pokémon TCG B&B Mini

> **Checkpoint protocol** (from `.clinerules/plans/02-tron-game-plan`): run ONE checkpoint per
> session turn. After each checkpoint run `npm run build` + `npm run lint`, report results, then
> STOP. Do not start the next checkpoint until the user replies "next". If interrupted, read this
> file, confirm the last completed step in Progress, and continue from there.

## Progress

- [x] 0 — Save this plan document
- [x] 1 — Data foundation (rng, cards, pack, 30C set data + pack config)
- [x] 2 — Shell + L10n + registry (translations, games/index, StartPage, skeleton views, CSS base, config seed)
- [x] 3 — Networking layer (peerjs dep, net/protocol.ts, net/peer.ts)
- [x] 4 — Lobby flow (host create + settings, guest join by code, start broadcast)
- [x] 5 — Pack opening (seeded ceremony, skip-all, PokemonCard, ready handshake)
- [x] 6 — Deck builder (pool grid, include/exclude, legality, ready handshake)
- [ ] 7 — Battle engine core (pure `game-core.ts`, full rulebook, local hot-seat validation)

  Sub-steps (one per editor pass; stop between each for review):

  - [x] **CP7-0** — Break down CP7 into implementation sub-steps (CP7-A through CP7-G) + confirm rulebook sources & card-data model.
  - [x] **CP7-A** — engine types + rulebook constants + `setupBattle` + mulligan.
  - [ ] **CP7-B** — action dispatcher + turn manipulation sub-phases (`attachEnergy`, `playTrainer`, `evolve`, `retreatToBench`, `useAttack`, `endTurn`).
  - [ ] **CP7-C** — attacks + effect parser + damage + KO/prize/victory.
  - [ ] **CP7-D** — turn lifecycle + statuses + timer + snapshots (`toSnapshot`/`applySnapshot`/`applyTimeout`).
  - [ ] **CP7-E** — wire `PokemonBnbGame.tsx`: `loading` → `playing` transition + `BattleState` state.
  - [ ] **CP7-F** — `?local=1` hot-seat harness (validation only, not player-facing).
  - [ ] **CP7-G** — validate (`npm run build` + `npm run lint` + key-parity + determinism note).

<!--
OPERATING CONVENTION (applies to every CP7 sub-step):
- Before reading code, editing, or running commands, re-read `.clinerules/plans/03-Pokemon-B&B-plan/03-Pokemon-B&B-plan.md`
  and confirm the current Progress line plus the current mode in the user's request (plan mode = explore/
  propose only; act mode = implement but still follow the plan + checkpoint protocol).
- One sub-step per session turn, then `npm run build` + `npm run lint`, report, and STOP until the user
  says "next". If context was compacted, re-verify any prior "done" claim from the files on disk before
  continuing, and never trust a summarized claim alone.
- Use exact `old_text` when editing (re-read files first); prefer `read_files` over `Get-Content`, and
  `search_codebase` over `Select-String`. No interactive pagers, no dev servers; see
  `.clinerules/04-terminal-commands.md`.
-->

<!--
NOTE (CP7 task author): the plan's draft `Types` block (CardDef/Attack/Effect/Ability unions) is
superseded by the real models in `src/games/pokemon-bnb/cards.ts` (PokemonCardDef / TrainerCardDef /
EnergyCardDef / AttackDef / AbilityDef / WeaknessDef / ResistanceDef). Do not copy the draft unions into
`game-core.ts`; consume `CardDef` and the card-type guards from `./cards`. Weakness/Resistance `value`
is a verbatim string ("×2", "×3", "-30", "-20"); parse it in the engine with a small normalized helper
(see CP7-C decision note) so future sets slot in unchanged.
-->

<!--
DECISION NOTES (from user, 2026-09-17):
- Weakness/Resistance values: keep the verbatim `value` string from card data (`"×2"`, `"×3"`, `"-30"`,
  `"-20"`); add a small normalized parser in `game-core.ts` (`parseWeaknessValue` / `parseResistanceValue`
  → `{ multiplier: number, reduction: number }`) defaulting to multiplier 2 / reduction 0, with an
  unparseable fallback to those defaults + a log note. This keeps future sets with the same shape working
  without engine changes.
- Card text: keep verbatim attack/ability/trainer/effect text as-is in the engine and in card rendering
  for now; do not try to render a text-driven "card face" from it beyond what `PokemonCard.tsx` already
  does. Future work: replace the typographic facsimile with real card images.
- Card images (future): source free/open card artwork from
  `https://limitlesstcg.com/cards/30C` (LimitlessTCG 30C card image endpoint) or another free/open TCG
  image API, and cache per-card images under `src/assets/pokemon-bnb/` so the build stays offline-capable.
  Track as a follow-up task; not part of CP7/CP8.
-->
- [ ] 8 — Battle UI (tabletop zones, counters, statuses, energy, log, pause)
- [ ] 9 — P2P battle sync + timer (host-authoritative, snapshots, disconnect, rematch)
- [ ] 10 — End flow + polish + docs (victory/defeat, highscores, settings, responsive, credits, diagrams, final validation)

## Overview

Build **Pokemon TCG B&B mini** (`pokemon-bnb`), a peer-to-peer (PeerJS) two-player Build-and-Battle
trading-card game where each player joins a lobby, opens a configurable number of packs from the
30th Celebration (30C) set, builds a limited-format deck from the cards they open, and battles
using rulebook-close Pokémon TCG rules, with the 30C set-data + pack/pull-rate system designed so
future sets can be added by dropping in data files.

Scope & approach:

- Game id `pokemon-bnb`; icon-only entry on the start hub; sources live in `src/games/pokemon-bnb/`,
  static set data in `src/assets/pokemon-bnb/` (mirrors `tron`/`bubble-trouble` layout).
- **Networking (user decision):** PeerJS default Cloud broker (free public signaling, needs
  internet) plus an optional self-hosted PeerJS server address field for offline **local-wifi**
  play. Host-authoritative battle sync: the lobby host runs the rule engine, guests send intents,
  host broadcasts snapshots.
- **Battle fidelity (user decision):** full rulebook-close engine — energy costs, retreat,
  Weakness/Resistance, Evolutions, Abilities, status conditions, Item/Supporter/Stadium/Energy
  Trainer cards, deck-out, prize-card victory condition — implemented as a pure `game-core.ts`
  (no React/DOM), with a fixed **effect-script library** so card texts map to implemented behaviors.
- **Fairness:** the host picks a random lobby seed and broadcasts it; every player derives the
  *same* deterministic card pool from that seed, so pulls cannot be cheated and both players open
  "the same shop". Deck building is private (deck contents revealed only as cards are played).
- **Lobby settings (all session-only, like Tron's rounds/colors — no `AppConfig` schema change):**
  set picker (30C only for v1), number of packs (1–6, default 1), prize cards (2–6, default 4 per
  B&B), timer (off or 45/60/90s per turn).
- **Full-rulebook constants** (hand size, Active/Bench/Prize counts, limited-format exact numbers)
  are transcribed from `par_rulebook_en.pdf` during the engine checkpoint (CP7) rather than guessed
  here; the mechanic list is complete.
- Card names/texts are **data**, not UI chrome: they live in `src/assets/pokemon-bnb/` and stay
  English (source-material fidelity). All button/label/status copy routes through `t()` in en/ms/zh.

## Types

Location: `src/games/pokemon-bnb/cards.ts` (no `enum` keyword — `erasableSyntaxOnly` forbids it;
use string-union types + `as const` arrays):

```ts
export type SetId = '30c'
export type CardRarity = 'common' | 'uncommon' | 'rare' | 'ultraRare' | 'illustrationRare'
export type CardSupertype = 'pokemon' | 'trainer' | 'energy'
export type TrainerCategory = 'item' | 'supporter' | 'stadium' | 'energy'
export type EnergyType = 'basic' | 'special'
export type PokemonCondition = 'basic' | 'evolution'
export type CardType = 'grass' | 'fire' | 'water' | 'lightning' | 'psychic' | 'fighting' | 'darkness' | 'metal' | 'colorless' | 'dragon'
export type EffectKind =
  | 'draw' | 'discardFromHand' | 'attachEnergy' | 'heal' | 'placeDamageCounter'
  | 'poison' | 'burn' | 'paralyze' | 'asleep' | 'confused'
  | 'pierce' | 'modifyDamage' | 'prizePlus' | 'prizeMinus' | 'retreatTarget'
  | 'moveToBench' | 'swapActiveBench' | 'preventPrize' | 'lookAtPrize' | 'ignoreType' | 'null'
export type Attack = { id: string; name: string; energyCost: number; handCost?: number; target: 'active' | 'bench'; damage: number; effects: Effect[] }
export type Effect = { kind: EffectKind; amount?: number; targetRole?: 'self' | 'opponent' | 'any'; condition?: CardType }
export type Ability = { trigger: 'onPlay' | 'oncePerTurn' | 'startOfTurn' | 'endOfTurn' | 'whenAttacking' | 'whenTakingDamage' | 'whenKnockedOut' | 'whileInPlay'; effects: Effect[] }
export type CardDef = { id: string; set: SetId; number: string; name: string; rarity: CardRarity; supertype: CardSupertype; types: CardType[]; hp?: number; retreatCost?: number; weakness?: CardType[]; resistance?: CardType[]; condition?: PokemonCondition; evolvesFrom?: string[]; attacks?: Attack[]; abilities?: Ability[]; category?: TrainerCategory; energyType?: EnergyType; effectId?: string; irVariation?: number }
```

`src/games/pokemon-bnb/rng.ts`:

```ts
export type Rng = { next(): number }          // 0..2^31-1, xorshift32, integer-only (browser-identical)
export function createRng(seed: number): Rng
export function shuffleCards<T>(items: T[], rng: Rng): T[]   // Fisher–Yates
```

`src/games/pokemon-bnb/pack.ts`:

```ts
export type PackSlotDef = { poolRef: string; count: number; weights: Record<string, number> }
export type PackDef = { set: SetId; size: number; slots: PackSlotDef[] }
export type OpenedPool = { cards: CardDef[]; byId: Map<string, number> }
export function openPacks(cards: CardDef[], pack: PackDef, count: number, rng: Rng): OpenedPool
export function weightedPick(slot: PackSlotDef, pool: CardDef[], rng: Rng): CardDef
```

`src/games/pokemon-bnb/net/protocol.ts`:

```ts
export type LobbySettings = { set: SetId; packs: number; prizeCards: number; timerSeconds: number } // 0 = timer off
export type NetMessage = { kind: 'hello' | 'lobby-update' | 'seed' | 'ready' | 'opening-done' | 'deck-done' | 'action' | 'snapshot' | 'log' | 'rematch' | 'leave'; payload: unknown; seq: number }
export type PlayerSlot = 'host' | 'guest'
```

`src/games/pokemon-bnb/game-core.ts` — engine types: `BattleState`, `ZoneKind =
'deck' | 'hand' | 'active' | 'bench' | 'prize' | 'discard' | 'lostZone' | 'energy'`,
`TurnPhase = 'draw' | 'main' | 'end'`, `Snapshot`, plus action types
(`attachEnergy`, `playTrainer`, `evolve`, `retreatToBench`, `useAttack`, `endTurn`, `applyStartOfTurn`).

## Files

### New files

| Path | Purpose |
|---|---|
| `implementation_plan.md` | This document |
| `src/assets/pokemon-bnb/README.md` | Asset/data folder contract + source citations (Limitless TCG, DigitalTQ, Pokémon.com rulebook) |
| `src/assets/pokemon-bnb/sets/30c/cards.json` | All 160 30C cards transcribed from limitlesstcg.com (id/number/name/rarity/supertype/types/hp/retreatCost/weakness/resistance/condition/evolvesFrom/attacks/abilities/category/energyType/effectId); 30 Pikachu Illustration Rares tagged `rarity: illustrationRare` with `irVariation: 1..30` |
| `src/assets/pokemon-bnb/sets/30c/pack.json` | Pack config: 5 slots — 2× Common, 1× Uncommon-or-better weighted, 1× Pikachu IR (1 of 30), 1× Basic Energy; weights verified against digitaltq.com during CP1 |
| `src/games/pokemon-bnb/cards.ts` | Card types + rarity/pool helpers + set registry interface |
| `src/games/pokemon-bnb/rng.ts` | Deterministic PRNG + seeded Fisher–Yates |
| `src/games/pokemon-bnb/pack.ts` | Slot/pool pack opening |
| `src/games/pokemon-bnb/deck.ts` | Deck-building legality (pool→deck counts, prize count, min/max, energy requirement) |
| `src/games/pokemon-bnb/game-core.ts` | Pure rulebook engine (setup, zones, turn phases, energy, attack, KO/prize, evolution, abilities, statuses, trainers, deck-out, timer, toSnapshot/applySnapshot) + effect-script library keyed by `effectId` |
| `src/games/pokemon-bnb/highscores.ts` | `highscores['pokemon-bnb']` read/record (Tron wins-per-name pattern) |
| `src/games/pokemon-bnb/net/protocol.ts` | Message envelope, lobby settings, snapshot/action types |
| `src/games/pokemon-bnb/net/peer.ts` | PeerJS wrapper: create/connect, cloud default + custom server URL, lifecycle, sendToPeer, keepalive, disconnect |
| `src/games/pokemon-bnb/PokemonCard.tsx` + `.css` | Reusable card face (rarity chip, name, HP, moves, type icons, effect text, damage counter, status pips, face-down back) |
| `src/games/pokemon-bnb/PokemonBnbGame.tsx` | Main page: view state machine, lobby, opening, deck, battle board, overlays, settings wiring |
| `src/games/pokemon-bnb/PokemonBnbGame.css` | All styles + 960×540 cap + portrait + mobile-landscape patterns |

### Modified files

| Path | Change |
|---|---|
| `package.json` | Add `peerjs ^1.5.5` dependency |
| `src/games/index.ts` | Add `pokemon-bnb` GameDefinition (titleKey 'games.pokemonBnbMini', page 'pokemon-bnb'), export `PokemonBnbGame` |
| `src/start/StartPage.tsx` | Route `selectedGame === 'pokemon-bnb'` to `PokemonBnbGame` |
| `src/assets/languages/en.json` / `ms.json` / `zh.json` | Add `games.pokemonBnbMini`, `gameInspiration.pokemonBnbMini`, `keyNames.confirm`, `keyNames.skip`, full `pokemonBnb.*` block |
| `src/assets/languages/index.ts` | Extend TranslationKey union with `pokemonBnb.${PkmBnbTranslationKey}` + `PkmBnbTranslationKey` union; add keyNames entries |
| `src/config/default.config.json` | Seed `highscores['pokemon-bnb'] = []` |
| `.github/diagram/database-schema.md` | GAME_CATALOG row + highscore bucket for `pokemon-bnb` |
| `.github/diagram/architecture-flow.md` | New `pokemon-bnb` runtime subgraph (P2P peer layer, engine, snapshots), game view state machine diagram, persistence call-site row |

## Functions

| Name | File | Purpose |
|---|---|---|
| `createRng(seed) / shuffleCards` | `rng.ts` | Deterministic seeding so host/guest open identical pools |
| `openPacks / weightedPick` | `pack.ts` | Slot-driven pack opening honoring 30C config + pull-rate weights |
| `buildPoolIsValid / deckSummary / countBySupertype` | `deck.ts` | Deck-builder counters + legality (prize count, min cards, energy presence) |
| `setupBattle(settings, deckA, deckB, seed)` | `game-core.ts` | Rulebook setup: deck zones, opening hand, face-down Active/Bench/Prize (counts from rulebook), shuffle |
| `attachEnergy / playTrainer / evolve / retreatToBench / useAttack / endTurn / applyStartOfTurn` | `game-core.ts` | Full turn sub-phases: energy ≤1/turn/Pokémon, retreat-cost discards, evolution stacking, attack energy+hand costs, status timing, trainer phase/name restrictions |
| `performKo / takePrizeCard / checkVictory` | `game-core.ts` | KO → discard + prize gain (guessing rules per rulebook), first-to-take-all-prizes victory, deck-out defeat |
| `applyEffect(effectId, targets) → log[]` | `game-core.ts` | Effect-script library per `EffectKind`; unsupported card text degrades gracefully |
| `processAction(state, actor, action) → { state, log, error? }` | `game-core.ts` | Single entry point for local validation and host-side network input (guest cannot inject state) |
| `toSnapshot(state) → Snapshot` / `applySnapshot(snapshot) → BattleState` | `game-core.ts` | Compact serializable state (face-down zones stay hidden; hand revealed only to owner) for network broadcast |
| `createHostPeer({ settings, serverUrl? }) → HostSession` | `net/peer.ts` | PeerJS spawn, lobby code (short host peer id), guest-join handling, broadcast, leave teardown |
| `joinPeer(code, serverUrl?) → GuestSession` | `net/peer.ts` | Connect by code; custom server URL or PeerJS Cloud |
| `PokemonBnbGame` (component) | `PokemonBnbGame.tsx` | View state machine host; orchestrates net + engine + render |

## Classes

No class-based OOP introduced (matches codebase: functional components + pure modules). Long-lived
connections are plain `HostSession` / `GuestSession` objects from the `net/peer.ts` factories
holding the `Peer`, peer id, and event callbacks; disposed in effect cleanup per project rules.

## Dependencies

- **`peerjs` ^1.5.5** (runtime dep) — WebRTC data-channel P2P over the PeerJS signaling broker.
  Default = free PeerJS Cloud; connect screen exposes an optional **server address** field for a
  self-hosted `peerjs-server` (LAN/offline play). No other new packages. No schema/config-version changes.
- Keep `react`, `three`, `vite`, `typescript` as-is; engine uses no Three.js (card tabletop is HTML/CSS).

## Testing / Validation

- No test runner in repo; validation = `npm run build` (`tsc -b && vite build`) + `npm run lint`
  (oxlint) after every checkpoint, plus en/ms/zh key-parity check.
- **Built-in local validation mode:** URL-param hot-seat mode (`?local=1`) on the Battle view lets
  two decks play on one screen against the pure engine — dev/QA only, not player-facing UI.
- RNG deterministic across browsers (integer-only xorshift32); dev console self-check confirms
  host/guest pull the same pool for a seed.
- Manual QA per checkpoint: lobby join over Cloud (+ self-hosted LAN if available), identical
  seeded packs, deck legality, each battle sub-phase (draw/energy/attack/retreat/evolve/status/
  prize/deck-out/timer), disconnect/rematch, three-viewport audit (960×540, ≤520px portrait,
  mobile landscape `max-height: 600px`).

## Implementation order

0. **Save plan** — `implementation_plan.md` at repo root.
1. **Data foundation** — `rng.ts`, `cards.ts`, `pack.ts`, `src/assets/pokemon-bnb/README.md`,
   `sets/30c/cards.json` (160 cards), `sets/30c/pack.json` (+ pull-rate weights from digitaltq.com).
   Validation: build + lint + seeded-pool determinism check.
2. **Shell + L10n + registry** — all `pokemonBnb.*` / `games.pokemonBnbMini` / `gameInspiration.*` /
   `keyNames.*` keys in en/ms/zh (+ index.ts unions), `games/index.ts` entry, `StartPage.tsx`
   branch, `PokemonBnbGame.tsx` skeleton with full view union + blank pages, `PokemonBnbGame.css`
   base, `default.config.json` highscore seed.
3. **Networking layer** — add `peerjs` dep; `net/protocol.ts`; `net/peer.ts` (cloud default +
   custom server URL, lifecycle). Verified with two tabs over the Cloud broker.
4. **Lobby flow** — host create (set/packs/prizes/timer controls) + guest join by lobby code
   (+ server field); connection status; host Start → broadcast settings + seed; both move to opening.
5. **Pack opening** — seeded ceremony: pack-by-pack, card-by-card flip with *Skip all*,
   `PokemonCard.tsx`, both-ready handshake → deck building.
6. **Deck builder** — opened-pool grid, include/exclude, counters, prize-card count, ready
   handshake → battle.
7. **Battle engine core** — full `game-core.ts` (rulebook constants transcribed from
   `par_rulebook_en.pdf`; all mechanics from Types/Functions), `deck.ts`; validated via `?local=1`.
8. **Battle UI** — tabletop board: zones (deck/hand/active/bench/prize/discard/energy), damage
   counters, status pips, energy attach, move select, log strip, help overlay, pause; hot-seat QA.
9. **P2P battle sync + timer** — host-authoritative actions/snapshots, guest render-from-snapshot,
   per-turn timer + timeout, disconnect/resync, rematch. QA over Cloud + (if possible) LAN.
10. **End flow + polish + docs** — victory/gameover, highscore save (wins/name), retry/exit,
    settings modal + key remaps (`pkm-bnb-confirm`, `pkm-bnb-skip`), mobile-landscape + portrait +
    960×540 pass, credits entry, `.github/diagram/*` updates, final full build + lint + key-parity
    + reachability audit.

## Assumptions / flags for user confirmation

- **1v1 matches** (classic B&B); PeerJS protocol leaves room for more players later.
- **Duplicate-containing identical pools** for fairness: both players open the same 30C seed pool;
  deck contents stay private until played.
- With the default **1 pack = 5 cards**, decks are far below the official 40-card Limited minimum;
  v1 enforces a small minimum deck (e.g., 6 cards + prizes) rather than the physical 40 — "mini"
  format. `packs` setting is the main balance knob (min deck rule noted at deck-build UI).
- 30C exact pull-rate percentages + full rulebook numeric constants (hand 7 / Active 6 / Bench 3 /
  Prize 6 per the Zone article, verified against the PDF at CP7) are transcribed at the relevant
  checkpoints, not fabricated now.

## Out of scope

- Real card scans/artwork (copyrighted); cards render as typographic/facsimile UI.
- More than 2 simultaneous players; non-30C sets (data structure ready for them).
- Achievements, profiles, stats pages.
- Persisting lobby settings in `AppConfig` (session-only by design, Tron precedent).

## Checkpoint notes

- **CP1 (done).** Set data source is the **TCGdex open API** (free, no key) instead of Limitless
  scraping — Limitless has no public per-card JSON. TCGdex set id `30th` → game set id `30c`.
  Facts discovered: 158 cards (68 common, 18 rare, 14 ultraRare, 58 illustrationRare incl. the 30
  "Pikachu Rare" guaranteed-slot variations 023–052), 3 Item trainers (Poké Pad / Switch / Ultra
  Ball), **no energy cards in the set** — the pack's energy slot is a synthetic basic-energy pool
  in `pack.ts`. TCGdex has no uncommon rarity for this set, so the hit-slot ladder bottoms out at
  rare with weights rare 74 / ultraRare 17 / illustrationRare 9 (measured 73.4/16.2/10.4 over
  1000 packs). `scripts/fetch-pokemon-set.mjs` is the reusable future-set pipeline
  (`node scripts/fetch-pokemon-set.mjs 30th src/assets/pokemon-bnb/sets/30c/cards.json 30c`).
- **CP2 (done).** `pokemonBnb` group (25 keys) + `games.pokemonBnbMini` + `gameInspiration.pokemonBnbMini`
  + `keyNames.confirm` / `keyNames.skip` added to all three dictionaries (parity 203/203). Registry
  entry `pokemon-bnb` (icon ⬢) exported with `PokemonBnbGame`; StartPage routes it. Skeleton view
  union: start / tutorial / lobby / lobbyJoin / opening / deck / loading / playing / paused /
  gameover / victory / highscore — non-start views render the `pokemonBnb.wip` placeholder with
  back/exit until their checkpoint lands. Locale state intentionally minimal in the skeleton
  (prop-driven; settings modal + `persistLocale` wiring returns in CP10). `default.config.json`
  seeds `highscores['pokemon-bnb'] = []`. Registry icon is a hexagon '⬢' (card-shaped, hub-safe).
- **CP3 (done).** `peerjs@1.5.5` added. `net/protocol.ts` = pure wire layer (`PROTOCOL_VERSION` 1,
  `LOBBY_LIMITS` packs 1–6 / prizes 2–6 / timers off·45·60·90, `defaultLobbySettings`,
  `clampLobbySettings`, `validateLobbySettings`, discriminated `NetMessage` union for hello /
  hello-ack / lobby-update / lobby-start(seed) / opening-ready / deck-ready(deckIds) /
  battle-action / battle-snapshot / leave / rematch, plus `isNetMessage` applied to every inbound
  frame). `net/peer.ts` = `createHost` (id `pkm-bnb-<CODE>`, rAF-free status flow
  connecting → waiting → connected, single guest seat, restartable after a drop, auto re-roll on id
  collision) and `joinHost` (code normalisation, `hello` on channel open, re-dial after a drop);
  `parseServerAddress` turns `192.168.0.12:9000` / `http://host/path` / `https://host` into a
  PeerServerConfig, blank input = PeerJS Cloud. `HostSession.code` is a live getter fed by
  `peer.id`, so retries rename the displayed code. Node validation (39 assertions, all passed)
  stubbed `peerjs` and drove both session state machines, including the `ID-TAKEN` retry.
  **Cloud broker verified live**: `wss://0.peerjs.com:443/peerjs?key=peerjs&id=pkm-bnb-…` →
  `OPEN`, simultaneous duplicate id → `ID-TAKEN` (peerjs maps this to error type
  `unavailable-id`, exactly what the retry listens for), fresh id → `OPEN`. Also confirmed
  peerjs's `validateId` regex accepts our hyphenated `pkm-bnb-XXX` ids. Note: peerjs loads the
  whole peerjs client (~290 kB minified) into the main bundle; consider lazy `import('peerjs')`
  or a vite `manualChunks` split in CP10.
- **CP4 (done).** Full lobby UI in `PokemonBnbGame.tsx`: start view gets the shared optional
  server-address field plus create/join; dedicated lobby view shows the host's copyable code,
  editable name, editable settings for the host (set segmented, packs/prizes steppers,
  timer segmented) with every change broadcast as `lobby-update` and clamped on receipt by the
  guest; guest `lobbyJoin` view holds name/code/server with short-code validation. Connection
  status dot (connecting/waiting/connected/error), `hello`/`hello-ack` names feed the
  `statusConnected` line, names re-announce on edit after connect, and `leave` resets or drops
  back to waiting. Host start rolls the shared seed and sends `lobby-start`, moving both seats
  to the `opening` placeholder. Embed CSS capped (`min(100%, 960px)`, portrait + landscape
  breakpoints). Build + lint clean.
- **CP5 (done).** Seeded pack-opening ceremony in `PokemonBnbGame.tsx`: both seats derive the
  identical `openedCards` sequence via `openPacks(cards, pack, packs, createRng(matchSeed))`
  (memoized on seed/set/pack-count; no opened cards ever cross the wire), revealing face-down
  → face-up one card at a time with a skip-all, progress + pack counters, and a translated
  `opponentReady` notice. Reusable `PokemonCard.tsx` + `PokemonCard.css` render the typographic
  facsimile (rarity chip, name/HP/types, stage, abilities, attacks, trainer/energy text,
  face-down back, damage/status overlay props reserved for CP8); card names/text stay English
  data, only the rarity chip + back label are translated (14 new `pokemonBnb.*` keys, parity
  89/89). `opening-ready` both-ready handshake (event-driven view switch via ready refs, no
  setState-in-effect) moves both seats to the `deck` placeholder; all ceremony/ready state
  resets on reseed/leave/rejoin. Build + lint clean.
- **CP6 (done).** Deck builder: new pure `deck.ts` (`buildPoolIsValid` /
  `deckSummary` / `countBySupertype` / `minDeckSize` — minimum = min(pool,
  prizes + 1) so 1-pack pools stay playable, plus ≥1 Basic and ≥1 Energy,
  copies clamped to opened counts) and a full `deck` view in
  `PokemonBnbGame.tsx` — seeded `openedPool` via `buildPool(openedCards)`,
  all-copies-included by default, selected/excluded grids with per-copy
  +/- (translated include/remove aria-labels + copy counts), live
  `{count} of {total}` counter, per-reason translated legality errors, and
  the `deck-ready` handshake (id list, one entry per copy) advancing both
  seats to `loading` when both are ready. Deck contents never render on the
  peer's screen (friendly-play privacy, per protocol comment). All match
  state funnels through `resetMatchState`; the stable message handler calls
  enter/reset through refs assigned post-render (no lint warnings). 14 new
  `pokemonBnb.*` keys (parity 103/103). Build + lint clean.



