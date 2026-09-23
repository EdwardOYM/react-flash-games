# Implementation Plan — Pokémon Pack Battle (04)

> **Checkpoint protocol** (from `02-tron-game-plan.md` + `05-agent-discipline.md`): run ONE
> checkpoint per session turn. After each checkpoint run `npm run build` (+ lint where relevant),
> report results, then STOP. Do not start the next checkpoint until the user replies "next".
>
> **Sub-step protocol (CP10 onward, mirroring the 03 plan's TASK format):** every checkpoint is
> split into sub-steps (`CP10-A`, `CP10-B`, ...) so no single pass carries a whole feature. Each
> sub-step states **Files / Inputs / Logic / Do-NOT / Gate**. Run ONE sub-step per session turn,
> validate with the narrowest command (`npm run build`, plus `npm run lint` for code), report
> files + behavior + result, then STOP and wait for "next". A checkpoint's `-0` sub-step (its own
> breakdown + probe) is never skipped, and no sub-step may quietly widen its own Do-NOT list.
> "Superseded sketch" blocks further down are pre-implementation history only, never pending work.

## Progress

- [x] CP0 — Pure core scaffold (unregistered): scoring, protocol fork, battlePack, highscores
- [x] CP1 — Registry + config seed + diagrams
- [x] CP2 — Start / tutorial / settings shell
- [x] CP3 — Lobby flow (PeerJS, packs 1-36, seed broadcast)
- [x] CP4 — Opening ceremony (1 pack/1 card, counter, synced reveal, flair + scoring)
- [x] CP5 — Results / highscore / credits
- [x] CP6 — Responsive + i18n + final validation
- [x] CP7 — Paired-pack ceremony (side-by-side per-seat packs, synced matching-card reveal)
- [x] CP8 — Guaranteed Pikachu IR scores 0 (identity-aware scoring)
- [x] CP9 — Card text face when no artwork paints the card (name + translated rarity)
- [ ] CP10 — Card-back artwork (real back for every face-down card, both games) — sub-steps (code work complete; only the human browser pass in Open human QA is open):
  - [x] CP10-0 — Breakdown + probe (asset facts, call sites, tooling, open source decision)
  - [x] CP10-A — Asset intake: bundled `card-back.jpg` (480x665 q90 = 79,029 B) + README credit row
  - [x] CP10-B — Extended `cardImage.ts`: `cardBackUrl` + `cardBackShowsArt` (pure; truth table 5/5)
  - [x] CP10-C — `PokemonCard.tsx`: back face paints `cardBackUrl`; gradient + mark stay the fallback
  - [x] CP10-D — `PokemonCard.css`: back-art rule (full-bleed cover; art covers the ⬢ by paint order) + real-browser audit
  - [x] CP10-E — Credits `cardBack` / `cardBackCredit` row + 3-dictionary parity (490/490/490) + README + diagram
  - [x] CP10-F — Validation: build + lint clean, 61/61 probe on a real seeded pack, exact-viewport audit (the human in-browser pass is QA-1…QA-4, still open)

## Overview

Build **Pokémon Pack Battle** (`pokemon-pack-battle`, game 04): P2P (PeerJS) two-player
pack-opening battle. Lobby like 03, pick packs 1-36, derive the identical deterministic pool
from the shared seed, open one pack per seat per round side by side and reveal the matching card
in both packs at once (either seat reveals both seats), score by rarity tier with card flair,
highest total wins.

Sources: `src/games/pokemon-pack-battle/`. Reuses 30c set data + TCGdex faces. No pack-battle
assets of its own (CP10 adds one *shared* card-back asset under `src/assets/pokemon-bnb/`, consumed
through the shared `PokemonCard`). Session-only lobby settings (never in `AppConfig`).

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

### Superseded sketch — CP1 — Registry + config + diagrams

- games/index.ts: add definition (titleKey games.pokemonPackBattle).
- default.config.json: seed highscores bucket.
- StartPage.tsx: route to pack-battle entry.
- architecture-flow.md + database-schema.md: runtime + bucket rows.

### Superseded sketch — CP2 — Start / tutorial / settings shell

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

### Superseded sketch — CP3 — Lobby flow

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

### Superseded sketch — CP4 — Ceremony

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

### Superseded sketch — CP5 — Results / highscore / credits

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

### Superseded sketch — CP6 — Responsive + i18n + final

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

## CP9 — Done

- Player-reported defect: some cards rendered as a blank, unlabelled tile. Two offline-verified
  causes: the synthetic basic energies (`name: "Fire Energy"`, `number: "E-fire"`), which
  `cardImageUrl` resolves to `undefined` and which occupy a slot in **every** pack, and any `<img>`
  that fails at runtime (offline, blocked CDN, missing asset). All 158 set cards do have hosted art,
  so the blank tiles were the art-less energies plus load failures.
- `PokemonCard.tsx`: on any failure to paint (no URL, or the URL that errored), the face now prints
  the card's own name plus the caller's already-translated rarity over the type tint
  (`.pkm-card-textface` / `.pkm-card-name` / `.pkm-card-textface-rarity`). The `onError` state is the
  failed **URL** (not a boolean), so a changed card can never inherit a stale failure, and the
  artwork branch is skipped for that URL. The duplicate rarity chip is suppressed while the text face
  is showing, and the card's accessible name becomes `name — rarity` in that state so the fallback is
  announced, not just drawn.
- Scope held: the face prints a name and a rarity line only — never HP/attacks/rules — so the CP11-E
  rule ("no `cards.json` text is rendered, the artwork IS the face") still holds for every card with
  working art, and the box metrics never change: both faces fill the same 8/11 frame.
- `PokemonCard.css`: text-face rules scale off the shared `--pkm-card-w` token (name ~10.5%, rarity
  ~6.2%, 3-line clamp, `overflow-wrap: anywhere`), so the face stays legible across the battle side
  panels, the pack-battle 3x2 ceremony rows, portrait 2-col and mobile landscape without any
  per-breakpoint CSS. The header comment's token-override list was stale (it named only
  PokemonBnbGame.css) and now also names the pack-battle roots `.ppb-page` / `.ppb-pair` the text
  face relies on — comment-only fix, no rule change.
- Localization: no new keys — card names are dataset proper nouns and the rarity is the caller's
  translated copy, which all six `PokemonCard` call sites already pass.
- Validation: `npm run build` ✓ (tsc -b + vite, 1.68s), `npm run lint` ✓ (0 warnings / 0 errors on
  53 files).
- Rendered the real component through `renderToStaticMarkup` (esbuild bundle + node, temp files
  removed): 33/33 assertions pass, run against a **real seeded pack** (engine output, not fixtures),
  covering the art-less energy (text face + translated rarity, no duplicate chip, `name — rarity`
  label, type tint kept), a card with art (image at the resolved URL, no text face, plain chip, no
  visible dataset text), the face-down back, and the exported `cardImage.ts` `cardFaceShowsText` rule
  the component renders from
  (no URL -> text; resolvable URL -> artwork; that exact URL failed -> text; a *different* failed URL
  is not inherited), with the rule's verdict cross-checked against the markup actually rendered for
  both the energy and the art card. The same run re-checks CP8 on that real pack: the `pikachu-ir`
  card is tier 0 / 0 points while the other cards still score per rarity. Observed pack row from the
  run: `30c-energy-lightning:common:0 | 30c-006:common:0 | 30c-072:common:0 | 30c-033:illustrationRare:0
  | 30c-059:common:0 | 30c-157:ultraRare:2` — the guaranteed IR is worth 0 despite its rarity, a
  ladder ultra rare still scores 2. The same run re-checks 200 seeds for exactly one guaranteed
  0-point Pikachu per pack.
- Scope note (no false claim): the `onError` *event* itself is not simulated — no DOM library
  (`jsdom` / `linkedom` / `happy-dom`) or test renderer is installed, and a function component's
  element tree cannot be walked pre-render. What is proven in-process is the decision rule and both
  rendered branches; the component derives its face from that same exported predicate, so the
  remaining DOM-level confirmation is the human in-browser check below.
- Remaining manual QA (human): confirm in-browser that the energy tile and an offline load both show
  the name + rarity text.

## CP10 — Card-back artwork (next)

Why now: CP9 shipped a face-down back that is a pure CSS gradient + ⬢ mark, because TCGdex hosts no
card back (recorded in `cardImage.ts`). A player-supplied card-back image now sits unused in the
assets tree, and `PokemonCard.tsx` is the single render point for every card face, so one wiring
covers Pokémon B&B (opening ceremony, prize and face-down faces, deck builder) **and** Pokémon Pack
Battle (sealed pack, unrevealed slot). Every sub-step follows the protocol at the top of this plan.

### CP10-0 — Breakdown + probe (DONE — measured, not assumed)

| Fact | Measurement |
|---|---|
| Asset | `src/assets/pokemon-bnb/pokemon_tcg_back.png` — untracked, written 21/9 10:41 pm, referenced by **no** file (grep `pokemon_tcg_back` = 0 hits) |
| Format | PNG, 32bpp ARGB, **828x1147 px**, ratio 0.7219 (the card frame `.pkm-card` is `aspect-ratio: 8/11` = 0.7273, so `object-fit: cover` crops ~0.7% of the height) |
| Size | **1,445,618 B (1.4 MB)** — larger than the whole current script bundle (`dist/index-*.js` = 1,101,756 B); `dist/` ships no image asset today |
| Provenance | Watermark `AtomicmonkeyTCG.deviantart.com` → a fan-made derivative; 01-flash-game-builder requires a credits entry for any added media/inspiration |
| Call sites | `PokemonBnbGame.tsx` (ceremony, prize/face-down faces, deck builder, `BattlePanel`) + `PokemonPackBattleGame.tsx` (sealed pack, unrevealed slot) — both games share `PokemonCard`, so one wiring covers both |
| Image-import precedent | none in `src/` (`hero.png` / `vite.svg` / `react.svg` are unreferenced); `tsconfig.app.json` sets `types: ["vite/client"]`, so a static `.png` import type-checks; `vite.config.ts` `base: './'` keeps emitted asset URLs relative, which the itch.io zip workflow needs |
| Local image tooling | `ffmpeg`, ImageMagick, `cwebp`, Python/PIL all **absent**; .NET `System.Drawing` works (it ran this probe) → any resize/re-encode step must be a throwaway PowerShell/.NET (or node) script deleted after the run, as this repo already does for probes |
| Decision (user, taken before CP10-A) | **bundle an optimized local copy** of the fan-made back, credited in all three dictionaries. Rejected: hotlinking a hosted back (which would have preserved the repo's "no stored art" posture). Either way the CP9 gradient stays the loading/failure face, so a back can never blank mid-flip. |

### CP10-A — Asset intake + source decision

- **Files**: `src/assets/pokemon-bnb/` (one new/optimized asset) + `src/assets/pokemon-bnb/README.md`.
- **Inputs**: the measurements above; the CP10-0 decision.
- **Logic (bundle branch)**: emit `card-back.png` at 480x667 (≥2x DPR for the widest rendered card —
  245 px in the B&B stage; default token 168 px) with a throwaway .NET `System.Drawing` script; report
  bytes before/after; keep the 1.4 MB original out of the repo (leave it untracked / delete it once the
  derived copy lands) and add the credit bullet, qualifying README's "nothing is downloaded or stored in
  the repo" line (card *art* hotlinked, card *back* bundled).
- **Logic (hotlink branch)**: no new asset; record the URL + host for CP10-B and add the same
  credit/README row.
- **Do NOT**: touch `PokemonCard.tsx` / `PokemonCard.css` yet; place anything under `sets/`; commit a
  1.4 MB file; introduce a runtime network dependency without the gradient fallback.
- **Gate**: `npm run build` + `npm run lint` clean; asset byte size and the credit line reported.

**Result (done)** - two deviations from this sub-step's sketch, both recorded before the code looked
at them:

- **Format/size deviation**: the sketch said `card-back.png` at 480x667. PNG of this artwork is
  573 KB at 480x665 (photographic gradient - PNG cannot compress it), so the shipped asset is
  **`src/assets/pokemon-bnb/card-back.jpg`**: 480x**665** (the source's true ratio, not a forced
  8/11), **JPEG q90 = 79,029 B** - 95% smaller than the 1,445,618 B original, and 2x the widest
  rendered card (245 px CSS in the B&B stage). Measured alternatives: PNG 480x665 573 KB / 400x554
  412 KB / 336x465 305 KB; JPEG q85 66 KB, q78 55 KB, 400x554 q85 51 KB. No WebP encoder exists on
  this machine (WIC exposes only BMP/JPEG/GIF/TIFF/PNG).
- **Alpha decision**: the art's corners are *genuinely transparent* (A=0 at all four corners,
  silhouette radius ~26 px at 828 px wide -> ~15 px at 480). Matting was therefore required, and the
  matte colour is the artwork's **own border colour `#192653`** (sampled at (30,30) and (414,1140)):
  the card frame's 10 px `border-radius` clip is *wider* than the art's silhouette (5.3-7.7 CSS px
  across the 168-245 px card widths), so those corner pixels stay inside the clip and must carry the
  border colour rather than show the frame behind them.
- Original `pokemon_tcg_back.png` (1.4 MB, untracked) removed from the repo **after** the derived
  copy was verified (480x665, ratio 0.7218); backed up first to `%TEMP%\cp10a-original-backup\`.
- `src/assets/pokemon-bnb/README.md`: the layout block lists `card-back.jpg`; the artwork credit
  bullet's "nothing is downloaded or stored in the repo" claim is qualified with the one exception;
  a new card-back bullet records source, format, size, matte and fallback, plus the
  `AtomicmonkeyTCG` credit row the credits page will mirror in CP10-E.
- No component or CSS file touched in this sub-step (CP10-C / CP10-D own those), and the asset is
  not imported yet, so `dist/` is unchanged until CP10-B/C wire it.

### CP10-B — Back-source module (pure)

- **Files**: `src/games/pokemon-bnb/cardImage.ts` (extend — it already owns "what paints this face?")
  or a co-located `cardBack.ts` if the import graph reads better (decision recorded here when made).
- **Inputs**: the CP10-A asset/URL; the existing `cardFaceShowsText` contract.
- **Logic**: export the back URL (bundled import or registry lookup) plus `cardBackShowsArt(url,
  failedUrl)` mirroring `cardFaceShowsText` exactly — no URL, or *that exact* URL already failed, means
  the gradient is the face; a different failed URL is never inherited. Pure: no state, no fetching, no
  React, so the rule stays verifiable without a DOM.
- **Do NOT**: change `cardImageUrl` / `cardFaceShowsText` behaviour; edit the component yet.
- **Gate**: `npm run build` + `npm run lint`; the predicate truth table is asserted in CP10-F.

**Result (done)**

- **Placement decision**: extended `src/games/pokemon-bnb/cardImage.ts` (no new module) - it already
  owns "what paints this face?", and the back is the other face of the same card, so both rules sit
  side by side and cannot drift. +27 lines; the two existing exports are untouched.
- Added: `import cardBackImage from '../../assets/pokemon-bnb/card-back.jpg'`, `export const
  cardBackUrl`, and `export function cardBackShowsArt(backUrl, failedUrl)` = the exact inverse of
  `cardFaceShowsText` (`Boolean(backUrl) && failedUrl !== backUrl`), documented as that inverse in
  the module header.
- **Truth table exercised rather than deferred** (esbuild bundle with `--loader:.jpg=text` + node;
  temp files deleted): `undefined/null` -> false, `url/null` -> true, `url/that-url-failed` -> false,
  `url/other-url-failed` -> true, `''/null` -> false = **5/5 PASS (TRUTH-TABLE-OK)**; `cardBackUrl`
  resolves to a non-empty string, and `cardFaceShowsText` / `cardImageUrl` are still exported
  unchanged. (CP10-F still re-asserts this inside the full render probe.)
- **Build evidence**: Vite emits `dist/assets/card-back-BlQaHM5N.jpg` (79,029 B) at a relative URL
  (`base: './'`), so the itch.io zip stays self-contained. The entry JS is byte-identical
  (`index-Ccu66U8P.js`, 1,101,756 chars; `pkm-card-back` x2, bare `card-back` x0) because both new
  exports still have no consumer, so Rollup tree-shakes them while the asset plugin emits the file
  anyway. That one-sub-step dead 79 KB in `dist/` disappears in CP10-C, when `PokemonCard.tsx`
  imports the URL and the reference lands in the bundle.
- No component, CSS, locale, config or diagram file touched (CP10-C/D/E own those).



### CP10-C — Component (the back face paints the artwork)

- **Files**: `src/games/pokemon-bnb/PokemonCard.tsx` only.
- **Inputs**: the CP10-B URL + predicate; the existing `faceDown` / `faceDownLabel` props.
- **Logic**: the back side renders an `<img className="pkm-card-back-art">` (alt="", `loading="lazy"`,
  `decoding="async"`, `draggable={false}`) above the gradient + ⬢ mark. `failedBackUrl` is state keyed by
  the failed **URL** (same shape as `failedUrl`), so the always-mounted gradient is both the loading
  state and the failure state and the back can never paint blank mid-flip. Props API, the accessible name
  (`faceDownLabel`) and the face/text-face path stay untouched.
- **Do NOT**: change the flip structure or the props API; keep a second flag that could desync from the
  URL; touch the CP9 text face.
- **Gate**: `npm run build` + `npm run lint`; the render probe shows the back image in the face-down
  branch and gradient + mark when that URL failed.

**Result (done)**

- **Component (the only file touched)**: `PokemonCard.tsx` - the back side renders
  `<img class="pkm-card-back-art">` (alt="", `loading="lazy"`, `decoding="async"`, `draggable={false}`)
  while `cardBackShowsArt(cardBackUrl, failedBackUrl)` holds, with `failedBackUrl` state keyed by URL
  exactly like the existing `failedUrl`. The gradient back and `pkm-card-back-mark` are never
  conditionally removed, so they are simultaneously the loading state and the failure state of the
  image. Flip structure, props API, accessible name, the CP9 art/text faces and the overlay chips are
  untouched.
- **Gate met by a real render probe, not by inspection** (throwaway `cp10c-probe.tsx`, esbuild + node
  `renderToStaticMarkup`, both deleted after the run): **16/16 PASS** - face-down state class; back
  image at the exported `cardBackUrl` with its decorative/lazy/non-draggable attributes; the gradient +
  mark present in that same render (exactly one mark); `aria-label` = the translated `faceDownLabel`;
  no dataset text on a face-down card; a revealed card flipped and painting the TCGdex art URL; the
  back side still mounted once revealed; the art-less energy still taking the CP9 text face; and the
  rule rows (art when nothing failed / hidden when that URL failed / a different failed URL never
  inherited). Observed tag:
  `<img class="pkm-card-back-art" src="<resolved>" alt="" loading="lazy" decoding="async" draggable="false"/>`
- **Scope note (no false claim)**: `onError` is not serialized into markup (asserted absent) and no DOM
  library is installed, so the failure state is proven by its parts - the predicate's `false` verdict
  for that URL plus the unconditionally present gradient + mark - while the browser error path stays
  the human check in CP10-F / QA-3, exactly as CP9 recorded. No dependency was added.
- **Build**: `index-B-P0mh36.js` = 1,102.02 kB (was 1,101.76 kB; the +0.26 kB is the URL string and the
  conditional), now containing `"card-back-BlQaHM5N.jpg"`, with the asset emitted at 79,029 B.
- **Known interim state (CP10-D owns it)**: `.pkm-card-back-art` still has no CSS rule, so until
  CP10-D lands the image is a centred, clipped intrinsic-size grid item instead of a covered
  full-bleed layer, and the gold mark paints over it. Deliberately not fixed here (this sub-step's
  Do-NOT) and it never reaches a build for the player. **Fixed in CP10-D (result below).**
- Gate: `npm run build` ✓ (2.16s), `npm run lint` ✓ (0 warnings / 0 errors, 53 files).

### CP10-D — CSS (back-art rules)

- **Files**: `src/games/pokemon-bnb/PokemonCard.css` only.
- **Logic**: `.pkm-card-back-art { position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; border-radius: inherit; }`, and hide the ⬢ mark while the art paints (a state class
  or `:has`, never a new global rule). `.pkm-card-back` keeps its gradient as the base layer, and the
  header comments that currently state the back is artwork-free are updated.
- **Do NOT**: re-declare another component's primitives; change `--pkm-card-w` or any box metric.
- **Gate**: `npm run build` + `npm run lint`; 960x540 / ≤520 px portrait / mobile-landscape audit — no
  crop artefact on the flip, no layout shift, no horizontal scroll.

**Result (done)**

- **CSS (the only file touched)**: `PokemonCard.css` — one new rule,
  `.pkm-card-back-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  border-radius: inherit; }`, plus two comment corrections (the file header, and a note on the rule).
  `git --no-pager diff` shows only the header comment and the added block: no existing selector was
  edited, so no metric, token, rarity/overlay or flip rule moved, and nothing was re-declared.
- **Deviation from the sketch (recorded, with reason)**: the ⬢ mark is **not** hidden with `:has` or a
  state class. `position: absolute` alone already moves the image into the positioned painting phase,
  so it paints above the static mark — measured, not assumed (below). That keeps this sub-step
  CSS-only (no `PokemonCard.tsx` edit, so CP10-C stays frozen), adds no new compatibility surface, and
  keeps the gradient + mark visible *while* the image loads instead of hiding the mark early.
- **Gate met by real browser measurement, not inspection** (throwaway `cp10d-shot.{tsx,html,js,css}`:
  esbuild IIFE rendering the real component at the games' real `--pkm-card-w` values — 168 / 148 / 118
  / 92 / 52 px — screenshotted by headless Chrome at 2x; all four files deleted after the run).
  Playwright's runner is **not** installed here (`node_modules/@playwright` is an empty stub, no
  `@playwright/test`, no bin, no spec/config in the repo, `e2e/` and `.agents/` empty), so `chrome.exe`
  was driven directly and no dependency was added:
  - **Full-bleed, no seam**: every token reports `card=170x233 backArt=168x231` (168 + 1px border a
    side, 8/11) — the image is exactly the card's content box. Pixel scan of the card's left edge at
    mid-height reads `…16,24,32 | x45-46: 255,200,87 | x47+: 25,38,83`, and `25,38,83` is byte-identical
    to the source JPEG's own edge colour (measured on `card-back.jpg` directly): the art starts at the
    first pixel inside the frame — no letterbox gap, no corner seam.
  - **The mark is covered**: `document.elementFromPoint` at the card centre returns
    `pkm-card-back-art` for every face-down card at every size, and `pkm-card-back-mark` only in the
    failure render — the paint-order mechanism confirmed per size.
  - **No leak over a face**: revealed cards report `topmost@centre=pkm-card-art`, so the back image
    never paints over a face-up card.
  - **Failure branch proven in a real browser** (closes the CP10-C / CP9 DOM gap): dispatching a real
    `error` event on each back image makes React drop it — `backArt=none
    topmost@centre=pkm-card-back-mark` at all five sizes, gradient + ⬢ as the whole back, faces
    untouched.
  - **No layout shift, no horizontal scroll**: `overflowX=false` with `scrollWidth == innerWidth` at
    the 960x540 embed, the 520x900 portrait and the 812x375 mobile-landscape viewports, with the same
    card boxes CP9 audited — expected, since the rule is absolutely positioned inside the existing
    `overflow: hidden` frame.
  - **Crop check**: `cover` trims ~0.8% of the image height (image 0.7218 vs frame 0.7273), centred, so
    side content and the bottom watermark are intact; the 2x corner crop shows a clean rounded edge.
- **Pre-existing affordance left alone**: the warm 1px rim on a face-down card is
  `.pkm-card-face-down { border-color: #ffc857 }` (CP8), untouched — measured identical
  (`255,200,87`) in both the art and the failure renders.
- **Scope note (no false claim)**: the audit renders the real component at the real token widths; it
  does not drive a whole game page (that needs a live lobby/match). The in-game and in-browser pass
  stays the human check in CP10-F / QA-4. The five screenshots are evidence on disk under
  `%TEMP%\cp10d-shots\` (`960x540-art`, `960x540-fail`, `520x900-art`, `812x375-art`,
  `corner-compare`) and are not committed.
- **Gate**: `npm run build` ✓ clean in 1.94s (`dist/assets/index-C4L8RS2L.css` 59.43 kB,
  `index-DoN729mi.js` 1,102.02 kB, `card-back-BlQaHM5N.jpg` 79.03 kB); `npm run lint` ✓ 0 warnings /
  0 errors (53 files); working tree carries only the six intended paths.

### CP10-E — Credits, dictionaries, README, diagram

- **Files**: `src/credits/CreditsPage.tsx`, `src/assets/languages/{en,ms,zh}.json` +
  `languages/index.ts` union (only if the credit needs new keys), `src/assets/pokemon-bnb/README.md`,
  `.github/diagram/architecture-flow.md`.
- **Logic**: credit the back's source through `t()` exactly like the existing artwork row; README's
  artwork/credits section gains the card back (source, byte size, fallback, and the updated removal
  path); the diagram's card-face edge notes the back asset.
- **Do NOT**: hardcode player-facing copy; add a key to one dictionary only; skip the `TranslationKey`
  union.
- **Gate**: `npm run build` + `npm run lint`; 3-dictionary parity (flat keys and `packBattle` equal,
  pairwise missing 0).

**Result (done)**

- **Files (7 paths, exactly the spec's list)**: `src/credits/CreditsPage.tsx` (+1 row),
  `src/assets/languages/{en,ms,zh}.json` (+2 keys each), `src/assets/languages/index.ts` (union +2),
  `src/assets/pokemon-bnb/README.md`, `.github/diagram/architecture-flow.md`. Nothing else touched.
- **The credit is translated, never hardcoded**: the row is
  `<div className="credit-row"><span>{t('cardBack')}</span><strong>{t('cardBackCredit')}</strong></div>`,
  directly under the existing artwork row; the artist, the fair-use framing and the trademark line exist
  only in the dictionaries (en "Card back" / "Card back artwork by AtomicmonkeyTCG …", ms "Belakang kad"
  / "Lukisan belakang kad oleh AtomicmonkeyTCG …", zh "卡背" / "卡背图像由 AtomicmonkeyTCG 创作 …").
  `TranslationKey` gained `cardBack` + `cardBackCredit`, so a wrong or missing key is now a compile error.
- **Gate met by a real render probe, not inspection** (throwaway `cp10e-probe.tsx` + `cp10e-parity.mjs`,
  esbuild bundle + node `renderToStaticMarkup`, both deleted after the run): **18/18 PASS** — per locale
  (en / ms / zh): 6 credit rows rendered (was 5), the translated label row present, the translated credit
  string present, **no raw translation key in the markup**, the credit names the artist, and the
  card-back row is not a copy of the artwork row.
- **Dictionary parity (the gate's numbers)**: **490 / 490 / 490** flat keys; missing in ms 0, missing in
  zh 0, extra in ms 0, extra in zh 0; `packBattle` 90 / 90 / 90. All three files parse, and the new
  strings are non-empty (176 / 204 / 107 chars).
- **README**: the card-back credit bullet names the mirrored row + keys, and a new
  "Removing the bundled card back (one commit)" section gives the four exact steps (delete the JPEG;
  drop the `cardBackImage` import + `cardBackUrl` + `cardBackShowsArt`; drop the back-image branch and
  the `.pkm-card-back-art` rule; drop the row + both keys from the three dictionaries and the union),
  noting the failed-load fallback becomes the permanent back so no play path changes. The hosted-artwork
  removal section now states the bundled back is independent of it.
- **Diagram**: the header note says the face-down side is the one bundled raster asset, and the
  `PokemonCard faces` edge + `cardArt` node name `cardBackUrl` / `cardBackShowsArt` and the full-bleed
  paint over the gradient back. Mermaid stays GitHub-compatible — both edits sit inside the existing
  quoted labels, adding no brackets and no extra double quotes (`git --no-pager diff` = 8 changed lines).
- **Scope note (no false claim)**: the probe renders the real `CreditsPage` with the real dictionaries
  but does not click through the running UI (that stays QA-3 / QA-4). The esbuild run needed
  `--jsx=automatic --loader:.css=empty --loader:.mp3=empty --loader:.png=empty --loader:.jpg=empty`
  because this repo imports assets directly — and the first failed run is itself evidence the card-back
  JPEG is in the module graph.
- **Gate**: `npm run build` ✓ clean in 2.04s (`index-DOcF9p39.js` 1,102.89 kB = +0.87 kB for the row plus
  the three dictionary strings; `card-back-BlQaHM5N.jpg` 79.03 kB); `npm run lint` ✓ 0 warnings / 0 errors
  (53 files); `git status` lists exactly the 7 touched paths with no probe leftovers.

### CP10-F — Validation (+ the human check)

- **Logic**: `npm run build` + `npm run lint`; a throwaway render probe (esbuild bundle + node
  `renderToStaticMarkup`, deleted after the run) proving the face-down card paints the back at the
  resolved URL, the gradient + mark survive the failure branch, the `cardBackShowsArt` truth table
  holds, and the CP9 assertions (art face, text face, `name — rarity` label) still pass on a real seeded
  pack; then the viewport audit and the human in-browser check (pack battle sealed pack → reveal, B&B
  prize faces, one offline load).
- **Do NOT**: claim the `onError` *event* itself is simulated — no DOM library is installed; record the
  in-browser confirmation as the human check, exactly as CP9 did.
- **Gate**: build + lint clean, probe assertions reported, plan Progress updated.

**Result (done — code validation; the browser pass is delegated to QA-1…QA-4)**

- **No production file changed** (the four throwaway probes were deleted; `Get-ChildItem cp10f-*` = 0).
- **Full render probe on a real seeded pack — 61/61 PASS** (throwaway `cp10f-probe.tsx`, esbuild bundle +
  node `renderToStaticMarkup`). Seed 20260923 opens exactly 5 cards
  (`101/pokemon/common 118/pokemon/common 082/pokemon/rare 033/pokemon/illustrationRare E-lightning/energy/common`);
  the same seed reproduces the identical pool and a different seed diverges. Per card, both states:
  back art exactly once at the exported `cardBackUrl` with its decorative/lazy/async/non-draggable
  attributes, exactly one ⬢ mark (the loading + failure face), the gradient layer present, the back half
  printing no card data at all (no text face, no card art, not even the name), `aria-label` =
  `faceDownLabel`, the flip structure intact; revealed: the TCGdex art URL + one rarity chip and no text
  face, or the CP9 text face (name + translated rarity, `aria-label` = `name — rarity`, no duplicate chip)
  for the art-less energy; and the back side stays mounted under every revealed face.
  Truth tables re-asserted: `cardBackShowsArt` 5/5, `cardFaceShowsText` 4/4. **Sweep: 25 seeds × the whole
  pack = 125 seeded cards, 0 face-rule violations.**
- **Honest note on the first run (49/61)**: all 12 FAILs were bugs in my *probe's* matcher, not the
  product — substring collisions (`pkm-card-art` ⊂ `pkm-card-artwrap`, `pkm-card-textface` ⊂
  `pkm-card-textface-rarity`, `pkm-card-rarity` ⊂ the article's own `pkm-card-rarity-<rarity>`). Replaced
  with exact class-token matching plus back/front half splitting, and the re-run is 61/61. No code was
  changed to make it pass.
- **Viewport audit against the PRODUCTION stylesheet** (`dist/assets/index-C4L8RS2L.css`, not the sources;
  throwaway `cp10f-page.tsx` writing a self-measuring page, headless Chrome; window chrome compensated
  with `--window-size=976,691 / 536,1051 / 828,526` to land on exact viewports): at **960×540**, **520×900**
  and **812×375** the document scroll width equals `innerWidth` (`960/960`, `520/520`, `812/812`) and the
  credits page's `scrollWidth == clientWidth` — **no horizontal scroll anywhere**. The credits page renders
  6 rows including the `AtomicmonkeyTCG` card-back row at every viewport. Card boxes are unchanged at every
  token (168×231, 148×204, 118×162, 92×127, 52×72) with the back art filling the content box
  (166×229 … 50×70) and `elementFromPoint(centre)` = `pkm-card-back-art` for **every** face-down card,
  `pkm-card-art` for revealed ones — and the 5th cell (the seeded energy) correctly reports
  `pkm-card-name`, i.e. the CP9 text face, in production CSS.
- **Real-app attempt (recorded as a negative result, no claim made)**: loading the built `dist/index.html`
  from `file://` at 960×540 does **not** boot the app — Chrome blocks ES modules over `file://`
  (`rows: 0`, no error object); this is a harness limitation, not a defect, so nothing about the real pages
  is claimed from it. The shipped bundle does reference the asset: `card-back-BlQaHM5N.jpg` is emitted and
  present in `dist/assets/index-DOcF9p39.js`.
- **Evidence**: 6 screenshots in `%TEMP%\cp10f-shots\` (`960,540.png`, `520,900.png`, `812,375.png`,
  `exact-976,691.png`, `exact-536,1051.png`, `exact-828,526.png`), not committed.
- **Still open (human, not code)**: QA-1…QA-4 — in particular QA-3 (offline/blocked CDN: the card back
  still paints and the energy tile still prints name + rarity) and QA-4 (viewport sweep on the real pages),
  which are the "human in-browser check" CP10-F names. They stay unticked until confirmed in a browser.
- **Gate**: `npm run build` ✓ clean in 1.76s (`index-DOcF9p39.js` 1,102.89 kB, `index-C4L8RS2L.css`
  59.43 kB, `card-back-BlQaHM5N.jpg` 79.03 kB); `npm run lint` ✓ 0 warnings / 0 errors (53 files);
  `src/assets/pokemon-bnb/` holds only `card-back.jpg` (79,029 B) + `README.md`; working tree = the 8
  intended paths.

## Open human QA (not code work — verify in a browser, tick when done)

- [ ] QA-1 — Pack battle, two browsers, 1 pack: create/join, both seats open and reveal the matching
  slot in both packs, results, rematch.
- [ ] QA-2 — Pack battle, two browsers, 6 packs and 36 packs: the same flow, packs-left counter, round
  limit, rematch across devices.
- [ ] QA-3 — Offline / blocked CDN (B&B and pack battle): the energy tile and any failed load show the
  name + translated rarity text, and the card back still paints (CP9 + CP10).
- [ ] QA-4 — Viewports: 960x540 embed, ≤520 px portrait, mobile landscape — no horizontal scroll on
  start, pack-battle ceremony, results and highscore.

## Hard rules
- 01-flash-game-builder: translated copy first; co-located CSS; 960x540.
- 02-diagram-flow-checks: single storage key; config I/O only; no dead ends.
- 04-terminal-commands: git --no-pager; non-interactive; ---done--- sentinel.
- 05-agent-discipline: one checkpoint per turn; verify on disk before claim.
