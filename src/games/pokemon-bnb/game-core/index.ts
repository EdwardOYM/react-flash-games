// Pure rulebook battle engine for Pokemon TCG B&B mini. No React, no DOM,
// no network: setupBattle + processAction + toSnapshot/applySnapshot drive
// both the local hot-seat harness (CP7) and the host-authoritative P2P sync
// (CP9). All randomness is the seeded xorshift32 Rng so both seats can replay
// the same match from the same seed.
//
// Mini-format adaptations (documented, deliberate — see B&B plan):
// - OPENING_HAND_SIZE = 7 per the real rulebook. The "4" value from the
//   pre-checkpoint draft is deliberately discarded here.
// - BENCH_TARGET = 3 (rulebook: auto-bench as many Basics as fit, up to 5).
// - Exact protocol-v2 deck size is 40; setupBattle rejects any other submitted deck.
// - `prizeCards` comes from LobbySettings and is taken from that same 40-card deck during setup.
// - Evolutions in 30C carry no `evolvesFrom` links (verified: 0 occurrences in
//   cards.json), so CP7-B matches by stage progression + a shared type, and
//   falls back to name matching when a future set does supply `evolvesFrom`.
// - Shared Stadium and one attached Tool are explicit turn/snapshot state.
// - CP5 ships the deterministic Ability registry: `classifyAbility` maps a
//   printed Ability text to a supported effect, `applyAbilityEffect` resolves it
//   against the seeded rng, and `abilityCoverageReport` lists what is supported
//   vs passive vs still unimplemented. 30C has 16 distinct Ability texts
//   (23 cards): 6 are player-triggered ("Once during your turn") and are
//   resolved; the rest are passive/static clauses (HP bonuses, damage
//   prevention, Bench cost reduction, Knock Out reactions) that the engine
//   does not simulate and reports as unsupported rather than guessing.
// - `state.log` holds structured `{ key, params }` entries, never English copy:
//   the log strip is player-facing status text, so templates are translated in
//   the UI while card names stay verbatim data.
// - Attacks resolve through `resolveAttack`; CP5 replaces the provisional
//   pattern-driven clauses with the audited Ability/effect registry.
// - `applyEffect` is pattern-driven because 30C card data carries no `effectId`
//   field at all (verified: 0 occurrences in cards.json) while 154 of its
//   attacks have effect text. Unsupported text logs
//   `pokemonBnb.log.effectUnsupported` instead of guessing, so coverage gaps
//   stay visible rather than silently wrong.
// - A Knock Out blocks every other action until the KO'd side promotes a
//   benched Pokemon via `promoteActive`; an empty bench loses the match.
// - Not yet implemented: self-Knock-Out sources and turn-locked /
//   damage-prevention clauses (they are logged as unsupported).
//
// Rulebook sources: Pokemon TCG Rulebook (pokemon.com), Bulbapedia "Rulings",
// "Pokemon Checkup", and "Setting Up to Play" articles.

// Module layout (CP7-E-a): the engine moved verbatim from game-core.ts into
// this folder along its section seams - constants, types, helpers, setup,
// actions, effects, turns, snapshots - and is re-exported here so existing
// `from './game-core'` imports keep working unchanged.

export * from './constants'
export * from './types'
export * from './helpers'
export * from './setup'
export * from './actions'
export * from './effects'
export * from './turns'
export * from './snapshots'
