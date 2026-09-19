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
- [x] 7 — Battle engine core (pure `game-core.ts`, full rulebook, local hot-seat validation)

  Sub-steps (one per editor pass; stop between each for review):

  - [x] **CP7-0** — Break down CP7 into implementation sub-steps (CP7-A through CP7-G) + confirm rulebook sources & card-data model.
  - [x] **CP7-A** — engine types + rulebook constants + `setupBattle` + mulligan.
  - [x] **CP7-B** — action dispatcher + turn manipulation sub-phases (`attachEnergy`, `playTrainer`, `evolve`, `retreatToBench`, `useAttack`, `endTurn`).
  - [x] **CP7-C** — attacks + effect parser + damage + KO/prize/victory.
  - [x] **CP7-D** — turn lifecycle + statuses + timer + snapshots (`toSnapshot`/`applySnapshot`/`applyTimeout`).
  - [x] **CP7-E-a** — restructure this plan into E-a…E-f (done by this very edit) **+ split the engine
        into modules**: move `game-core.ts` (~1380 lines, 66 exports) verbatim into a
        `src/games/pokemon-bnb/game-core/` folder along its existing section seams —
        `types.ts` (BattleState/Snapshot/BattleAction/… types), `constants.ts` (rulebook constants),
        `helpers.ts` (sideOf/foeOf/logEvent/clone/failure/checkTurn/canPayCost/canEvolveOnto/stage…),
        `setup.ts` (setupBattle, mulligans, opening flip, prizes, draw/placePrizes),
        `actions.ts` (attachEnergy/playTrainer/evolve/retreatToBench/declareAttack/endTurn/promoteActive
        + processAction), `effects.ts` (parseAttackEffects/applyEffect/computeAttackDamage/resolveAttack/flipCoin),
        `turns.ts` (applyStartOfTurn/applyEndTurn/applyCheckup/applyTimeout/performKo/takePrizeCard/checkVictory),
        `snapshots.ts` (toSnapshot/applySnapshot/HIDDEN_CARD), and an `index.ts` re-export barrel so
        existing `from './game-core'` imports keep working. Code moves verbatim; only imports change.
        The single file is deleted after the split. (User decision, 2026-09-18: full 8-module split
        for scaling + accessibility; see the checkpoint note at the bottom.)
  - [x] **CP7-E-b** — locale keys only (pure data): add the engine's ~33 `pokemonBnb.log.*` keys,
        the engine error-code copy (~26 `error.*` keys: not-your-turn, energy-limit, insufficient-energy,
        must-promote, view-only, …) and battle UI keys (turn header, zone labels, condition names,
        match-over banner) to en/ms/zh + the `PkmBnbTranslationKey` union; keep 3-way key parity.
  - [x] **CP7-E-c** — component wiring only in `PokemonBnbGame.tsx`: store the opponent's
        `deck-ready` ids, `beginBattle()` from both ready paths (`setupBattle` with the shared
        seed, deck ids resolved to CardDefs from the shared pool), reset clears the battle,
        `loading` → short timer → `playing` (Tron's 500 ms effect pattern).
  - [x] **CP7-E-d** — battle render + CSS in `PokemonBnbGame.css`: turn header (whose turn,
        turn #), side panels (active card name/HP/damage/energy/conditions, bench, hand/deck/
        prizes/discard counts), translated log strip (params substituted, seat display names),
        error-code → translated copy helper; 960x540 embed cap + landscape breakpoint.
  - [x] **CP7-E-e** — update `.github/diagram/architecture-flow.md` (engine module layout +
        `loading → playing` transition in the view state machine), mark E-a…E-e done.
  - [x] **CP7-F** — `?local=1` hot-seat harness (validation only, not player-facing).
  - [x] **CP7-G** — validate (`npm run build` + `npm run lint` + key-parity + determinism note).

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
- [x] 8 — Battle UI (tabletop zones, counters, statuses, energy, log, pause)

  Sub-steps (one per editor pass; stop between each for review):

  - [x] **CP8-0** — Break down CP8 into implementation sub-steps (CP8-A through CP8-F) + confirm scope vs CP7-E-d render and CP7-F harness.
  - [x] **CP8-A** — locale keys only (pure data): battle action copy (attach/play/evolve/retreat/attack/end/promote), selection labels, pause/resume/help overlay copy, turn/phase status copy in en/ms/zh + `PkmBnbTranslationKey` union; keep 3-way key parity. (Done: 18 flat `pokemonBnb.*` keys, parity 195/195/195; build + lint clean.)
  - [x] **CP8-B** — action driver in `PokemonBnbGame.tsx`: `runBattleAction(actor, action)` through `processAction` (local seats pre-CP9), selection state (hand/bench/attack picks), `battleError` surfacing; harness reuses the driver. (Done: B-1 guards for null/over/viewOnly + always-set state/error + boolean result; B-2 selHand/selBench/selAttack + clearBattleSelection cleared in resetMatchState and on driver success only; B-3 runLocalAction delegates to the driver so `?local=1` still plays a full turn; build + lint clean.)
  - [x] **CP8-C** — tabletop upgrade: `BattlePanel` renders `PokemonCard` faces (damage counters, status pips, attached energy), bench select, own-hand interaction, prize/discard counters; foe hand stays count-only. (Done: C-1 Active `PokemonCard` face with damage/statuses + `⚡n` + translated condition line; C-2 bench as `bnb-bench-list` with toggle buttons + aria-pressed on own side, static faces on foe side; C-3 own hand as `bnb-hand-list` toggle buttons with translated aria-labels, foe renders nothing; C-4 prize header already uses `side.prizeCount` — verified, no change. No dispatches, no CSS, no locales; build + lint clean.)
  - [x] **CP8-D** — controls + overlays: turn action bar (attach/evolve/trainer/retreat/attack/end), promotion picker gate, pause overlay (resume/leave, Tron pattern) + help overlay; `paused` becomes a solid state-machine transition. (Done: D-1 `bnb-action-bar` toolbar with own-turn gating, selHand/selBench-targeted attach/evolve, trainer/retreat, per-attack verbatim-name buttons + translated aria prefix, always-on end-turn, waiting/your-turn notices + selection hints, no P2P send; D-2 `bnb-promote-gate` dialog reusing selBench + confirm promoteActive, bar hidden + must-promote notice while gated; D-3 Pause button (disabled when over) → `paused` renders tabletop under overlay with Resume → `playing` + Leave → `leaveLobby`, battle untouched, wall-clock left to CP9; D-4 `?` help dialog with title/body/Close autofocus, no view change, state cleared in resetMatchState. No new keys, no engine change; build + lint clean.)
  - [x] **CP8-E** — CSS in `PokemonBnbGame.css`: action bar, card zones, overlays; 960x540 embed cap + landscape breakpoint + ≤520px portrait; no global CSS. (Done: E-1 `bnb-action-bar` toolbar (flex-wrap, 960px cap, `.bnb-actions` rhythm) + `bnb-bench-list` auto-fit minmax(120px,1fr) grid / `bnb-hand-list` flex with gold `aria-pressed` selected states, `:disabled` + `:focus-visible`, bench `.pkm-card` min-height 0 shrink, no `.pkm-card` internals re-declared; E-2 fixed `bnb-overlay` rgba(16,24,32,.72) z-20 + 480px card + dashed-gold `bnb-promote-gate` docked at 960px cap with safe-area padding; E-3 landscape adds bar margin + 18vh log cap on the existing `min(calc(100dvh-96px), calc(100vw*.5625))` stage, portrait adds 2-col bar + 2-col bench grids with no h-scroll. No tsx/locale changes; build + lint clean.)
  - [x] **CP8-F** — validate (`npm run build` + `npm run lint` + key-parity + three-viewport audit) + sync `.github/diagram/architecture-flow.md` (solidify pause transition). (Done: F-1 build pass + lint 0/0, throwaway parity script 95 refs / 0 missing with pokemonBnb counts 195/195/195 (script deleted), `?local=1` regression via shared driver unchanged since CP8-B (attach/attack/KO/promote/endTurn + translated error copy — no harness edits in CP8-D/E), three-viewport audit by code: 960x540 stage cap + `16/9` untouched, landscape `min(calc(100dvh-96px), calc(100vw*.5625))` + bar margin + 18vh log cap, ≤520px portrait 2-col bar/bench with minmax(0,1fr) no h-scroll; F-2 pause edges solid `PPLAYING <-> PPAUSED`, results stay dashed, placeholder note rewritten. Build + lint clean.)
- [x] 9 — P2P battle sync + timer (host-authoritative, snapshots, disconnect, rematch)

  Sub-steps (one per editor pass; stop between each for review):

  - [x] **CP9-0** — Break down CP9 into implementation sub-steps (CP9-A through CP9-F) + confirm scope vs CP7-D engine (`toSnapshot`/`applySnapshot`/`applyTimeout`), CP3 protocol wire kinds (`battle-action`/`battle-snapshot`/`leave`/`rematch`), and CP8-D action driver (`runBattleAction`). Full user-confirmed scope: host-authoritative sync + turn timer + disconnect/resync + rematch. (Done: this edit; no code. Ground truth verified — engine: `toSnapshot(state, viewer)` per-seat privacy + `applySnapshot` viewOnly guard + `applyTimeout` forfeits expired turn (no-op when 0); protocol: `battle-action {player, action: unknown}` + `battle-snapshot {snapshot: unknown}` + `leave` + `rematch` all guarded by `isNetMessage`; component: `runBattleAction` runs the engine directly today with `viewOnly`/`match-over` guards, guest must switch to intent-send at CP9-B; `resetMatchState` already resets battle/selection, timer/pause state joins at CP9-C/E. No schema/registry/CSS changes; no validation run — pure plan edit.)
  - [x] **CP9-A** — locale keys only (pure data): P2P battle copy (connection lost/reconnected, opponent disconnected, turn timer labels, timeout notice, rematch offer/accepted, resync notice) in en/ms/zh + `PkmBnbTranslationKey` union; keep 3-way key parity. (Done: 11 flat `pokemonBnb.*` keys — connectionLost/connectionRestored/opponentDisconnected/resyncNotice/timerRemaining/timerExpired/rematchOffer/rematchWaiting/rematchReceived/rematchAccept/rematchAccepted — added to all three dictionaries + the union; parity 384/384/384 total, pokemonBnb 206/206/206, pairwise 0 missing; 95 literal t() refs all resolve; build + lint clean. No component/CSS/schema/diagram changes.)
  - [x] **CP9-B** — host-authoritative action path in `PokemonBnbGame.tsx`: guest `runBattleAction` sends `battle-action` intent instead of running the engine; host validates via `processAction` and broadcasts per-seat `battle-snapshot` (`toSnapshot(state, seat)`); guest renders via `applySnapshot`. `?local=1` keeps the direct engine path. (Done: `battleRef` holds the host's live engine state (synced by effect) while `battle` renders the host's own privacy-scoped snapshot; `broadcastBattle` sends host+guest `battle-snapshot` frames; `beginBattle` runs one authoritative `setupBattle` on the host (guest waits on the snapshot); guest intents send and return true, host validates/broadcasts; host failures re-render its own snapshot so turn flags never drift. No protocol/locale/CSS changes; build + lint clean.)
  - [x] **CP9-C** — turn timer wall clock in `PokemonBnbGame.tsx`: countdown from `timerSeconds` per turn, host calls `applyTimeout` on expiry and broadcasts; guest shows the same countdown from snapshots; `0` disables. Pause freezes the clock. (Done: elapsed time is stored per turn key `seed:turn:seat:limit` and `secondsLeft` is **derived during render** (`Math.max(0, timerSeconds - elapsed)`) instead of reset by an effect, so a new turn starts full with no seeding `setState`, a mid-turn action (which re-broadcasts a snapshot) cannot refund time, and pause freezes/reports the remaining seconds rather than resetting; ticks only while `playing`; the expiry path fires a deferred macrotask that re-checks `battleRef`, skips identity no-ops (`applyTimeout` returns the same ref when off/over) and only acts locally for `?local=1` or on the host (`applyTimeout` → `broadcastBattle`), the guest just displays. Timer chip in the turn header (`bnb-timer`, tabular-nums). **Three defects found and fixed while wiring:** (1) a duplicate `localMode` memo left by the CP7-F harness (build error); (2) the CP9-B host guard `if (battle.viewOnly && roleRef.current === 'host') return setBattleError('view-only')` rejected *every* host action, because `broadcastBattle` renders the host's own state as `applySnapshot(toSnapshot(state,'host'))` which is `viewOnly` — the guard is removed and the documented invariant is now `battle` = render snapshot, `battleRef` = live authoritative state; (3) the initial timer implementation tripped `react(set-state-in-effect)` (lint 1 warning), which the derived-during-render design eliminates. No protocol/locale/engine/schema changes; `applyTimeout` needed no engine edit. Validation: 29/29 assertions in a throwaway esbuild-bundled harness (snapshot roundtrip keeps `turn`/`activePlayer`/`timerSeconds`/`over` + is `viewOnly` and un-actionable, derived timer key stable across snapshots within a turn, `applyTimeout` advances exactly one turn / flips the seat / logs / never mutates input, identity no-op when timer off or over, same-seed determinism, opponent-hand ids absent from the wire, `timerRemaining` present in en/ms/zh with a `{count}` slot); `npm run build` + `npm run lint` clean (0 warnings / 0 errors); throwaway scripts deleted.)
  - [x] **CP9-D** — disconnect/resync: `onPeerDisconnected` notice (no battle teardown), host re-sends the latest per-seat snapshot on re-`hello` (guest re-dial), guest re-renders from it; `leave` still tears down via `leaveLobby`. (Done: **net/peer.ts** — `joinHost` now re-dials itself: `dial()` extracted, `close` clears `conn`/`helloSent`, sets `waiting` and calls `scheduleRedial()` (single pending timer, `REDIAL_DELAY_MS` 1200 ms, bounded by `REDIAL_LIMIT` 12, counter reset on a successful open, timer cleared in `dispose`), because the broker session usually stays open after a data-channel drop so no `open` event repeats to re-dial from. **PokemonBnbGame.tsx** — new `connLost` state + `connLostRef` mirror, `viewRef` mirror, and a `showNotice()` helper that auto-clears the transient notice after 6 s (a one-shot `setNotice` had left disconnect copy on screen indefinitely). `onPeerDisconnected` no longer tears a match down: mid-battle (`viewRef` playing/paused) it keeps the engine state, raises `connLost` and shows `opponentDisconnected` (the `bnb-conn-lost` banner carries `opponentDisconnected` + `resyncNotice`); outside a battle the guest returns to `start` and the host returns to `waiting`. `onPeerConnected` only confirms the restore once and never re-routes a view. `readMessage` resolves the resync: `hello-ack` clears `connLost` + shows `connectionRestored`, and the host's `hello` handler re-broadcasts the live per-seat snapshots from `battleRef` (guarded `!live.over`) so the re-dialled guest rebuilds its view without a restart. `leave` mid-battle now ends the host's match locally via inline teardown (`closeSession` + `resetMatchState` + `start`) instead of calling `leaveLobby`, which was read before its declaration — a real `no-use-before-declare` lint error found and fixed by this pass; `battleRef.current` is also nulled in `resetMatchState` (it had kept a stale authoritative state, so rematch/resync could replay a dead match). New `.bnb-conn-lost` CSS at the existing 960×540/landscape/portrait rules. No protocol/locale/engine/schema changes — all wire kinds already existed. Validation: `npm run build` clean (only the pre-existing >500 kB advisory); `npm run lint` clean (0 warnings / 0 errors, after fixing the read-before-declare).)
  - [x] **CP9-E** — rematch handshake: `rematch` offer/accept over the existing wire kind returns both seats to `opening` with a fresh seed (host rolls, `lobby-start`); battle/selection/timer state reset via `resetMatchState`. (Done: **no protocol/locale/schema change** — the CP3 `rematch` wire kind was unused until now and needed no edit. `requestRematch()` (guest-only, hidden in `?local=1`): sets `rematchSent` + `rematchSentRef` and sends `{ kind: 'rematch' }`; the match-over area shows `rematchOffer` until the guest is waiting, then `rematchWaiting` with `{player}` = the host's seat name. Host side: the `rematch` handler ignores offers outside a finished match (`roleRef === 'host'` + `battleRef.current` live and `over`) and flips `rematchOffered`, which renders `rematchReceived` (`{player}` = guest seat) plus a `rematchAccept` button; `acceptRematch()` delegates to the existing `startPackOpening()`, so the host rolls a fresh `randomSeed()`, resets both seats and broadcasts `lobby-start` — the guest's `lobby-start` case already resets + reseeds, and now records whether it was answering a rematch (`rematchSentRef`) to keep the `rematchAccepted` notice instead of clearing the strip. Both seats land back in `opening` on the new seed, and `resetMatchState` clears the rematch flags/ref, notice params, the derived turn-timer record and the connection banner, so no rematch state leaks into the next match. **CP9-D follow-up defect fixed:** `opponentDisconnected` copy is `"{name} disconnected."` but every notice site rendered a bare `t(notice)`, so a literal `{name}`/`{player}` token could reach the player — notices now render through `noticeText` (`showNotice` seeds `{name}`/`{player}` defaults from `opponentNameRef`, with per-call overrides) at all 7 notice call sites, and the `bnb-conn-lost` banner reuses the same substitution. New `.bnb-rematch` CSS. No engine/protocol/schema/registry/diagram changes. Validation: `npm run build` clean (only the pre-existing >500 kB chunk advisory) + `npm run lint` 0 warnings / 0 errors; disk-verified the offer/accept render block, the guest acceptance branch and the reset clearing.)
  - [x] **CP9-F** — validate (`npm run build` + `npm run lint` + key-parity + `?local=1` regression + two-tab Cloud QA when available) + sync `.github/diagram/architecture-flow.md` (host-authoritative sync + snapshot render + timer/pause + rematch edges). (Done — **CP9 complete**. Gates: `npm run build` clean (only the pre-existing >500 kB chunk advisory); `npm run lint` 0 warnings / 0 errors. Throwaway `scripts/cp9f-parity.mjs` (deleted after the run): flat-key parity 384/384/384 en/ms/zh, pokemonBnb 206/206/206, 0 pairwise missing, 167 literal `t('pokemonBnb.*')` uses / 102 unique all resolving, and 24/24 engine error codes mapped to `pokemonBnb.error.*` copy. Throwaway `scripts/cp9f-regress.mjs` (esbuild-bundled against the real engine + set data, deleted after the run): **14/14 assertions passed** covering (A) same seed → byte-identical authoritative `setupBattle` state for host and replay, different seed → different state; (B) the CP9-B render contract — `applySnapshot(toSnapshot(state,'host'))` is `viewOnly` and `processAction` on it is refused with `view-only`, returning the state untouched, which is exactly why the host must act on the live `battleRef` state; (C) host-authoritative guest intents apply on the live host state (`endTurn` advanced turn 1 → 2) while that state stays non-view-only; (D) the CP9-C timer — `applyTimeout` changes the state, flips `activePlayer` (guest → host) and advances `turn`, giving the UI the fresh countdown key it derives seconds from, and is a no-op when `timerSeconds` is 0; (E) the CP9-E rematch — a fresh seed genuinely remixes the pool (so a rematch is a new match) and the real flat wire envelope (`{kind:'rematch'}` / `{kind:'lobby-start', seed, settings}`, not the plan's superseded `{kind,payload,seq}` draft) is accepted by `isNetMessage` with `PROTOCOL_VERSION` still 1. Both scripts deleted; `scripts/` back to its tracked contents. Diagram sync landed in `.github/diagram/architecture-flow.md` (+24/−7): a new host-authoritative sync note (battle-action intent → host `processAction` → per-seat `battle-snapshot` → `applySnapshot`; `battleRef` vs `battle`), the timer edge to the engine, and a peer edge for disconnect-redial/re-hello replay + rematch; the view-union note now says paused is solid since CP8 with results pending CP10; the state-machine prose was rewritten for the host-authoritative model, the freeze-in-pause countdown, the redial banner, and the rematch → fresh-seed handshake; and the `flowchart LR` gained `PPAUSED ⇄ PPLAYING` remains solid plus new edges for timer expiry, the connection-lost banner round-trip, and rematch → `POPENING`, with results still dashed (CP10). Mermaid-safe (quoted labels, no raw brackets). **Two failed harness assertions were both fixture bugs, not engine defects** (`openPacks` returns `OpenedCard[]` so a deck needs `.map(o => o.card)`; and the timeout case used timer-off settings) — each verified against the source before fixing. Two-tab Cloud QA is manual and not runnable in this environment; the disconnect/resync and rematch paths are covered by the code-level checks above plus the CP9-D re-dial assertions. No schema, registry, or config changes at this checkpoint.)
- [ ] 10 — End flow + polish + docs (victory/defeat, highscores, settings, responsive, credits, diagrams, final validation)

  Sub-steps (one per editor pass; stop between each for review):

  - [x] **CP10-0** — Break down CP10 into implementation sub-steps (CP10-A through CP10-F) + confirm scope vs the CP7-C victory/KO engine, CP9-E rematch flow, and Tron's end-flow/highscore precedent. (Done: this edit; no code. Ground truth verified — **reachability defect**: `setView('gameover' | 'victory' | 'highscore')` appears nowhere in `PokemonBnbGame.tsx`, so those three views are dead ends today (the `View` union declares them, and `loading`/`playing`/`paused`/results share the placeholder branch at line 1613) — CP10-C must make results reachable *and* leaveable; **highscores**: no `src/games/pokemon-bnb/highscores.ts` exists yet, `default.config.json` already seeds `highscores['pokemon-bnb'] = []`, and `.github/diagram/database-schema.md` has no pokemon highscore/persistence row — Tron's `readHighscores()` / `recordMatchWin(name)` (per-name match-win tally, top-10, `updateConfig`) is the pattern to mirror; **keybindings/settings**: `SettingsModal` + `ControllerSettings` accept `additionalBindings: AdditionalKeyBinding[]` (`{id, labelKey, defaultKey}`) and persist to `AppConfig.settings.keybindings[id]`, the Pokemon component passes none yet (no `keybindings`/`keyNames`/`mobile` refs at all), and `keyNames.confirm` / `keyNames.skip` already exist in all three dictionaries; **locale**: `StartPage` passes a persisting `onLocaleChange`, so the component only needs to delegate (Tron's `persistLocale` is for standalone use); **credits**: `CreditsPage` lists every registry game via `titleKey` + `inspirationKey`, and `gameInspiration.pokemonBnbMini` is present in en/ms/zh (CP2) — so the credit entry is already wired; **copy inventory**: 149 flat `pokemonBnb.*` keys + nested `log`/`error`, already including `gameOver` / `victory` / `highscore` / `retry` / `backToStart` / `matchOverTitle` / `winReason*` / the 11 CP9 rematch keys — CP10-A only needs the remaining results/highscore/settings gaps (highscore column labels, defeat/result titles, rematch + play-again button copy); **responsive**: no movement sticks for this game (touch = the action bar), so no `mobileControls` schema usage; **diagram**: `architecture-flow.md` still carries "results are placeholders until CP10" and a dashed `PPLAYING -.-> PRESULTS` edge. No code/schema/registry/CSS changes; no validation run — pure plan edit.)
  - [x] **CP10-A** — locale keys only (pure data): results copy (victory/defeat titles, result summary, play-again/rematch), highscore copy (column labels `rank`/`player`/`wins`/`noScores`, saved notice, empty state), and any settings/help gaps in en/ms/zh + the `PkmBnbTranslationKey` union; keep 3-way key parity (no re-adding CP9-A keys). (Done: 10 flat `pokemonBnb.*` keys — resultVictory / resultDefeat / resultReason / resultPrizes / playAgain / highscoreSaved / rank / player / wins / noScores — added to all three dictionaries + the union. Existing keys were deliberately reused instead of duplicated: `victory`/`gameOver`/`highscore`/`matchOverTitle`/`winReason*`/`retry`/`backToStart`/`exit`/`leaveLobby` for the results chrome and `rematchOffer`/`rematchAccept`/`rematchWaiting`/`rematchReceived`/`rematchAccepted` for the offer flow, so CP10-C composes copy rather than inventing more. Highscore column labels mirror Tron's `tron.rank`/`player`/`wins`/`noScores` → `HighscoreLabels { rank, playerName, score, noScores }` (`player`→playerName, `wins`→score). No `settings`/`keybinds` key needed — `SettingsModal` + `ControllerSettings` read those from the global dictionary (`t('settings')`, `keybinds` default) and `keyNames.confirm`/`keyNames.skip` already exist (CP2). Validation: throwaway `scripts/cp10a-parity.mjs` (deleted after the run) — flat keys **394/394/394**, `pokemonBnb` **216/216/216**, pairwise missing **0**, CP10-A coverage **30/30**, **166 literal `t()` uses / 103 unique — 0 unresolved**, placeholder audit flags `resultReason`/`resultPrizes`/`highscoreSaved` as `{…}`-bearing for CP10-C substitution; `npm run build` + `npm run lint` clean (0 warnings / 0 errors). No component/CSS/schema/registry/diagram changes.)
  - [ ] **CP10-B** — new `src/games/pokemon-bnb/highscores.ts` mirroring `tron/highscores.ts`: `readHighscores()` (bucket `highscores['pokemon-bnb']`, top-10 by wins) and `recordMatchWin(name)` aggregating per player name case-insensitively; one record per match, winner only. No schema change (bucket already seeded); `database-schema.md` row lands in CP10-F.
  - [ ] **CP10-C** — end flow in `PokemonBnbGame.tsx`: `battle.over` drives `victory` (local seat won) / `gameover` (lost) once, `recordMatchWin` fires once per match for the winner, `highscore` view with the shared `HighscoreTable` (translated labels), and every results view leaves: rematch (guest offer / host accept, reusing the CP9-E handshake), retry (fresh lobby seed → `opening`) and back-to-start (`leaveLobby`). No dead ends; `?local=1` results path included.
  - [ ] **CP10-D** — settings + keybindings in `PokemonBnbGame.tsx`: pass `additionalBindings` (`pkm-bnb-confirm` / `pkm-bnb-skip`) into `SettingsModal`, read overrides through `AppConfig.settings.keybindings`, and wire Confirm/Skip to advance/skip the opening ceremony and to confirm the promotion/attack pick; locale changes delegate to `onLocaleChange`. No schema change.
  - [ ] **CP10-E** — responsive + polish in `PokemonBnbGame.tsx` / `PokemonBnbGame.css`: results/highscore/settings styling, touch-friendly action bar, 960×540 embed cap + `≤520px` portrait + mobile-landscape audit (no horizontal scroll), and credits/`inspiredBy` verification (entry already auto-listed).
  - [ ] **CP10-F** — final validation (`npm run build` + `npm run lint` + throwaway key-parity/`?local=1` end-flow regression, deleted after) + docs/diagrams: `.github/diagram/architecture-flow.md` (results edges solid, view union note, persistence call-site row) and `.github/diagram/database-schema.md` (`GAME_CATALOG` pokemon row + `highscores['pokemon-bnb']` bucket), then mark CP10 (and the whole plan) complete.

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
- **CP7-B (done).** Turn sub-phases + dispatcher in `game-core.ts`:
  `processAction(state, actor, action) -> { state, log, error? }` is the single entry point (local
  hot-seat and host-side network intents alike); invalid actions return the untouched state plus a
  stable error code, so a guest can never inject state. Sub-phases: `attachEnergy` (one Energy per
  turn, plus a per-Pokemon same-turn stamp), `playTrainer` (Item unlimited, Supporter/Stadium once
  per turn; 30C's 3 trainers are all Items), `evolve` (stage progression + shared type, because
  30C card data contains **zero** `evolvesFrom` fields — verified by search; name matching is used
  when a future set does supply it), `retreatToBench` (discards Energy equal to the retreat cost;
  blocked while Asleep/Paralyzed), `declareAttack` (turn/cost/status validation; attacking ends the
  turn per rulebook), `endTurn` + `applyStartOfTurn` (per-turn flag reset + draw, guarded by a
  `turnStarted` flag so a double call cannot double-draw). Three CP7-A amendments, all documented in
  the file header: `attachedEnergy` now stores Energy **cards** (cost checks read `provides`),
  `log` is now `BattleLogEntry[]` (`{ key, params }`) because the battle-log strip is player-facing
  status text that must be translated while card names stay verbatim data, and turn numbering now
  starts at 1 with setup Pokemon stamped `enteredTurn: -1` and adopted on their controller's first
  turn (this is what implements "no evolution on your first turn"). The plan's `useAttack` is
  implemented as `declareAttack` because the `use` prefix trips the repo's `react/rules-of-hooks`
  error, and the repo's precedent (plan 01, step 12) is to fix such findings rather than suppress
  them. Attacks are validated but not yet damaging: damage, effects, KO, prizes and victory land at
  the marked seam inside `declareAttack` (CP7-C). Validation: `npm run build` + `npm run lint` clean
  (0 warnings / 0 errors), plus a throwaway Node harness (esbuild-bundled engine, **65 assertions,
  all passing**) that exercised every sub-phase through `processAction` and caught a real defect —
  with `turn` starting at 0, setup Pokemon carrying `energyAttachedTurn`/`retreatedTurn` sentinels of
  `0` made every once-per-turn action fail on the first turn. Harness deleted after the run (the repo
  has no test runner); it can be re-added as a committed script on request.
- **CP7-C (done).** Damage, effects, KO, Prizes and victory in `game-core.ts`.
  `parseWeaknessValue` / `parseResistanceValue` (the names and `{ multiplier, reduction }` shape the
  CP7-0 decision notes specify) replaced the earlier `weaknessMultiplier` / `resistanceReduction`;
  both default to ×2 / −0 and now report unreadable values through
  `pokemonBnb.log.unreadableWeakness` / `…Resistance` so a fallback is never silent.
  `computeAttackDamage` applies the defender's weakness entry matching the attacker's type, then
  resistance, floored at 0. `parseAttackEffects` + `applyEffect` resolve card text; `resolveAttack`
  runs the pipeline in order (damage modifiers → Weakness/Resistance → damage → non-damage clauses →
  Knock Out) and is called from `declareAttack`. `performKo` / `takePrizeCard` / `checkVictory` /
  `prizesTaken` implement the rulebook order (KO'd Pokemon + attachments to discard, attacker takes
  one Prize, then the KO'd player promotes), with deck-out defeat wired into `applyStartOfTurn`. A
  KO blocks every other action until the KO'd side promotes via the new `promoteActive` action, so
  there is no dead end; an empty bench loses immediately. Coin flips are seeded
  (`createRng(seed + rngDraws)`) so both peers agree.
  **Two findings that change the plan's premises, both verified against the data:**
  1. **`cards.json` contains no `effectId` field at all (0 occurrences)**, so the plan's
     `applyEffect(effectId, targets)` cannot be keyed by data id. Effects are recognised from the
     verbatim text instead. `applyEffect` keeps the plan's name but takes `(state, effect, context)`
     because clauses mutate zones and coin gates need the seeded rng.
  2. **Effect coverage is low and must not be overstated**: of 154 attacks carrying effect text,
     **35 are fully recognised, 3 partially, and 116 not at all**; **23 cards declare abilities that
     remain unimplemented** (no action can trigger one and no CP7 sub-step covers them). Unsupported
     text logs `pokemonBnb.log.effectUnsupported` instead of guessing — deliberately, because a wrong
     effect is worse than a missing one (conditional clauses such as "for each Water Energy attached"
     and "If this Pokemon has any Lightning Energy" are downgraded, never applied unconditionally).
    Self-Knock-Out sources (attack recoil, Confusion self-hit, Poison/Burn at Checkup) are excluded
    from CP7-C because they can KO the attacker during its own turn and need the promotion-timing
    design that arrives with statuses in CP7-D.
  Validation: `npm run build` + `npm run lint` clean (0 warnings / 0 errors), plus a throwaway Node
  harness (esbuild-bundled engine, **87 assertions, all passing**) covering the parsers, damage
  maths, Weakness/Resistance ordering, effect parsing and downgrades, KO/discard/Prize/promotion
  flow, the `must-promote` gate, all three victory conditions, and the unreadable-value fallback.
  Both harnesses were deleted after the run. Two harness fixture bugs surfaced during validation
  (a `grass`-weak defender against a `darkness` attacker, and per-turn flags not reset between
  cases); the engine was correct in every case — it rejected the stale attacks as `already-attacked`.
  No persisted schema, default config, registry, view state machine or module wiring changed, so the
  `.github/diagram/*` files still need no update at this checkpoint (that lands with CP7-E).

- **CP7-D (done).** Turn lifecycle, statuses, timer and snapshots in `game-core.ts`.
  `applyEndTurn` runs the between-turns **Pokemon Checkup** (`applyCheckup`): Poison 20, Burn 20 +
  a seeded coin (tails cures), Asleep coin (heads wakes), Paralysis cured only for the player who
  just finished (it costs its victim the next turn), Confusion deliberately *not* checked here —
  it is rolled at attack time: `declareAttack` flips a seeded coin and on tails logs
  `confusionSelfHit`, deals the 30 self-damage (which can self-KO and set `pendingPromotion`) and
  still ends the turn. Checkup damage can KO either Active, reusing `performKo` (promotion gate /
  empty-bench loss). `applyTimeout` forfeits the expired turn (rule-least-open-to-abuse) and is a
  no-op when `timerSeconds` is 0; the wall clock stays in the UI so the engine stays pure.
  Snapshots follow the CP7-A `Snapshot`/`SnapshotSide` shape: `toSnapshot(state, viewer)` copies
  public zones verbatim (discard piles, in-play Pokemon + attached Energy), keeps face-down zones
  as **counts only** (`deckCount`, `prizesTaken` — never arrays over the wire) and includes the
  hand only for the viewer (`null` for the other side); `applySnapshot` rebuilds a `viewOnly`
  BattleState whose hidden zones hold the new `HIDDEN_CARD` placeholder, and `processAction`
  refuses view-only states (`'view-only'` error), so a guest can never inject state.
  Validation: `npm run build` + `npm run lint` clean (0 warnings / 0 errors), plus a throwaway Node
  harness (esbuild-bundled engine, **43 assertions, all passing**) covering the snapshot roundtrip
  through a JSON wire copy, the hidden-zone non-leak probe (a guest hand-only card id appears
  nowhere in the serialized snapshot), the `viewOnly` guard, timeout end/no-op, every Checkup
  branch with controlled seeded flips, both Confusion rolls, Checkup-KO promotion vs empty-bench
  loss, and same-seed determinism. Both harness files were deleted after the run. All five
  harness failures were fixture bugs, not engine bugs, each verified before fixing: the seeded
  `openingFlip` can open with guest (tests assumed host), and two assertions read damage from the
  immutable input state instead of `result.state` (actions clone since CP7-B). No persisted
  schema, config, registry, view state machine or wiring changed — `.github/diagram/*` updates
  remain due with CP7-E.

- **CP7-E-a (done).** Engine module split in `src/games/pokemon-bnb/game-core/` (user decision,
  2026-09-18: full 8-module split for scaling + accessibility). `game-core.ts` (~1381 lines) moved
  verbatim along its section seams into `constants.ts` (rulebook numbers), `types.ts`
  (state/snapshot/action types; `STATUS_CONDITIONS` lives here because `StatusCondition` derives
  from it), `helpers.ts` (zone access, logging, cloning, once-per-turn rejection, cost/evolution
  legality, Weakness/Resistance parsers, plus `drawCards`, shared by setup/effects/turns),
  `setup.ts` (opening hands, mulligans, seeded flip, Active/Bench/Prize placement), `actions.ts`
  (attachEnergy/playTrainer/evolve/retreatToBench/declareAttack/endTurn/promoteActive +
  `processAction`), `effects.ts` (flipCoin, damage maths, effect parse/apply, resolveAttack),
  `turns.ts` (applyEndTurn/applyStartOfTurn/Checkup/timeout/KO/Prize/victory), and `snapshots.ts`
  (toSnapshot/applySnapshot/HIDDEN_CARD), with an `index.ts` barrel keeping the original engine
  header and re-exporting everything so future `from './game-core'` imports (CP7-E-c) work
  unchanged. The move was mechanical (a throwaway Node codemod sliced the original by line
  ranges, then deleted), so every body is byte-identical except nine deliberate `export ` prefixes:
  `logEvent`/`drawCards`/`inPlayOf`/`inPlayList`/`failure`/`checkTurn`/`tailLog` (helpers) and
  `applyEndTurn`/`applyDeckOutLoss` (turns), which other modules call. Two cross-import seams:
  actions → effects/turns, and effects ↔ turns (`flipCoin` vs
  `performKo`/`prizesTaken`/`applyDeckOutLoss`) — function-declaration-only, safe under ESM
  hoisting and documented in both module headers. No persisted schema, config, registry, view
  state machine or wiring changed; diagram updates still land with CP7-E-e. Validation:
  `npm run build` + `npm run lint` clean (0 warnings / 0 errors).

- **CP7-E-b (done).** Locale keys only (pure data), 75 new keys per dictionary
  (281 -> 356 flat keys, 3-way parity verified). Engine log keys are nested as
  `pokemonBnb.log.*` (33 keys, exactly the strings the engine emits, so CP7-E-d can look them up
  directly), engine error codes as `pokemonBnb.error.*` (26 keys, kebab code -> camelCase key,
  including `notYourTurn` / `notMainPhase` which `checkTurn` returns rather than passes through
  `failure`), plus 16 flat battle-UI keys: `turnHeader`, six zone labels (`zoneActive`/`zoneBench`/
  `zoneHand`/`zoneDeck`/`zonePrizes`/`zoneDiscard`), five condition names
  (`conditionAsleep`/`conditionParalyzed`/`conditionConfused`/`conditionPoisoned`/`conditionBurned`),
  `matchOverTitle` and three win reasons (`winReasonPrizes`/`winReasonDeckOut`/`winReasonNoPokemon`).
  Seat display names reuse the existing `hostRole`/`guestRole`. Supporting `index.ts` changes:
  `readTranslation` now walks every dot segment (behavior-preserving for existing two-level keys)
  so three-level keys resolve, the `TranslationKey` union gained
  `pokemonBnb.log.${PkmBnbLogTranslationKey}` / `pokemonBnb.error.${PkmBnbErrorTranslationKey}`
  template members, and the two new unions + 16 flat members were added. Validation: a throwaway
  Node checker (deleted after the run) confirmed equal flat key counts (356/356/356), no pairwise
  missing keys, and exact engine coverage (33/33 log keys, 26/26 error codes) in all three
  dictionaries; `npm run build` + `npm run lint` clean (0 warnings / 0 errors). No component,
  schema, registry, view-state or diagram changes.

- **CP7-E-c (done).** Battle wiring in `PokemonBnbGame.tsx` (+56/−6). `beginBattle()` follows the
  component's ref-called-implementation pattern (`beginBattleRef` assigned in the always-run
  ref-sync effect, so the stable data-channel handler and `markDeckReady` call it without
  definition-order hazards): it resolves both deck-id lists against the shared `openedPool`
  (ids → `CardDef`), maps seats via `roleRef` (guest's deck is the engine's `guestDeck`), and runs
  `setupBattle(settingsRef.current, hostDeck, guestDeck, matchSeed)` into a new `battle` state —
  no battle data crosses the wire; both seats derive the identical state from the shared seed.
  The `deck-ready` handler now stores the opponent's ids in `opponentDeckIdsRef` (cleared by
  `resetMatchState`, which also nulls `battle`), and both both-ready paths (peer-first via
  `readMessage`, self-first via `markDeckReady`) advance `loading` + call `beginBattle()`.
  `loading → playing` uses Tron's exact 500 ms timeout effect, guarded on `battle !== null` so a
  failed setup can never strand a seat (defensive; the handshake makes it unreachable). Render is
  untouched — the loading/playing placeholder stays until CP7-E-d. Validation: `npm run build` +
  `npm run lint` clean (0 warnings / 0 errors); bundle +~14 kB from the engine now being imported
  by the component (expected). No schema, registry, CSS, or diagram changes.

- **CP7-E-d (done).** Battle render + CSS. `PokemonBnbGame.tsx`: a `view === 'playing' && battle`
  branch renders the tabletop — turn header (turn number + active seat), two `BattlePanel` side
  panels (zone counters hand/deck/prizes {remaining}/{total}/discard, Active line with name, HP,
  damage, attached-Energy count and translated condition names, bench names, and the viewer's own
  hand as name chips), a translated log strip (last 24 entries, auto-scrolled to the newest via a
  ref + effect), and the match-over banner (winner + translated win reason). Log translation
  substitutes `{player}` with the lobby display names (fallback `hostRole`/`guestRole`) and
  `{status}` with the translated condition label; card/attack text stays verbatim data. The
  opponent's hand stays count-only (CP6 privacy) until CP9's `toSnapshot` views. New
  `battleError` state (cleared by `resetMatchState`) displays engine error codes through
  `battleErrorCopy` (kebab code -> camelCase `pokemonBnb.error.*` key), currently surfaced for the
  `must-promote` gate notice and ready for CP8/CP7-F actions. Damage/energy use `−n`/`⚡n`
  glyph+number chips (no English words), so no new keys were needed beyond CP7-E-b's set.
  `PokemonBnbGame.css`: `bnb-battle*`/`bnb-side*` styles with the stage at `min(100%, 960px)` +
  `aspect-ratio: 16/9`, the shared landscape breakpoint (`height: min(calc(100dvh - 96px),
  calc(100vw * .5625))`, safe-area handled by `.bnb-page`), and a ≤520px portrait query stacking
  panels with a clamped log strip. Validation: `npm run build` + `npm run lint` clean (0 warnings
  / 0 errors). No schema, registry, or diagram changes (architecture-flow engine layout lands
  with CP7-E-e).

- **CP7-E-e (done).** `.github/diagram/architecture-flow.md` synced with CP7-E: the hub registry
  now routes to `pokemon-bnb/PokemonBnbGame.tsx`; a new "Pokemon TCG B&B mini runtime" subgraph
  documents the P2P peer layer (peer.ts/protocol.ts, single stable onMessage closure), the seeded
  data modules (sets/cards/rng/pack/deck — deterministic identical pool), and the engine module
  layout (`game-core/` index barrel over constants / types / helpers / setup / actions / effects /
  turns / snapshots, pure, no React/DOM/network) fed by `deck-ready` ids resolved against the
  shared pool into `setupBattle(settings, hostDeck, guestDeck, seed)`; the STATE subgraph gained
  the pokemon view union; and a new "Pokemon B&B mini view state machine" section documents
  start → tutorial / lobby / lobbyJoin → opening → deck → loading (500 ms) → playing, with
  dashed CP8/CP10 transitions for pause and results, the leaveLobby escape, and the CP9 note that
  guests will render from host snapshots. Persistence call-site table unchanged — the pokemon
  game performs no config I/O yet (highscore/persistLocale wiring is CP10 and will add its rows
  then). Validation: `npm run build` + `npm run lint` clean (0 warnings / 0 errors). CP7-E
  sub-step E-a…E-e all complete; CP7 continues at CP7-F.

- **CP7-F (done).** `?local=1` hot-seat harness in `PokemonBnbGame.tsx` (+~120 lines) + CSS —
  dev/QA only, invisible without the URL param. `localMode` (memoized URLSearchParams read) plus
  a once-per-load mount effect calls `beginLocalBattle()`: it skips the lobby/peer session
  entirely, builds both seats the same deck from a fresh-seed max-packs `openPacks` pool, runs
  `setupBattle(settingsRef.current, deck, deck, seed)` and enters `playing` on one screen. A
  `LocalSeatControls` strip per seat drives the engine through `processAction` (attachEnergy with
  hand + active/bench selects, playTrainer, evolve, retreatToBench, promoteActive gated on
  `pendingPromotion`, endTurn, and one button per Active attack) — exercising every CP7-B/C/D
  sub-phase, KO/prize/promotion, deck-out, timeout and both victory paths before CP8's real
  interactions land. Engine rejections surface through the existing translated `battleError`
  slot; buttons intentionally carry the technical action ids (dev identifiers, not player copy),
  while selects use the translated zone labels. Harness styles are scoped (`bnb-harness-*`), and
  the harness block may overflow the 16:9 stage by design (desktop page scrolls; the stage itself
    is untouched). Validation: `npm run build` + `npm run lint` clean (0 warnings / 0 errors).

- **CP7-G (done).** Final CP7 validation — throwaway script `scripts/cp7g-validate.mjs`
  (esbuild-bundles the pure engine + sibling data modules, asserts, then is deleted), then re-ran the
  standard gates. (1) **Determinism** — `setupBattle` + an identical `processAction` (`endTurn`)
  sequence yields byte-identical `BattleState` for the same seed (host vs guest), and differs for a
  different seed — seed-driven determinism confirmed (**4/4 assertions passed**), the property CP9
  relies on for host-authoritative snapshots. (2) **Key parity** — every literal
  `t('pokemonBnb.*')` ref in `PokemonBnbGame.tsx` resolves in en/ms/zh: **75 refs, 0 missing**.
  `npm run build` clean (only the pre-existing >500 kB chunk-size advisory); `npm run lint` —
  **0 warnings / 0 errors**. Throwaway script + in-tree `cp7g-entry.mjs` both removed; `git status`
  clean of them. No persisted schema, default config, registry, view state machine, or diagram
  changes this checkpoint; `.github/diagram/*` needs no update for CP7. **CP7 (Battle engine core)
  is fully done — ready for CP8.**