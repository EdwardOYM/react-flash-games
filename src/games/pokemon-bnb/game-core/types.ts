// Engine types for the Pokemon TCG B&B mini battle engine. STATUS_CONDITIONS
// and StatusCondition live here (not constants.ts) because the zone, state
// and snapshot types derive from them directly.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { CardDef, EnergyCardDef, PokemonCardDef, TrainerCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'

export const STATUS_CONDITIONS = ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'] as const
export type StatusCondition = (typeof STATUS_CONDITIONS)[number]

export type ZoneKind = 'deck' | 'hand' | 'active' | 'bench' | 'prize' | 'discard' | 'lostZone' | 'energy'
export type TurnPhase = 'draw' | 'main' | 'attack' | 'between'
export type SetupPhase = 'turnOrder' | 'mulligan' | 'placement' | 'prizes' | 'complete'
export type SetupPlayerState = {
  phase: SetupPhase
  coinWinner: PlayerSlot
  firstPlayer: PlayerSlot | null
  mulliganDone: Record<PlayerSlot, boolean>
  ready: Record<PlayerSlot, boolean>
  revealed: boolean
}
export type SpecialConditionState = Record<StatusCondition, boolean>

/**
 * One legal target of a pending choice. `zone` reuses the `'active' | number`
 * convention the existing `target` actions already use for Active-vs-Bench.
 *
 * `uid` is the authority, NOT the index. 04.8 CP2-C found why: an attack can
 * Knock Out the Active AND park a choice, and `performKo` gates the promotion
 * AHEAD of the choice. Promoting splices a Pokémon out of the Bench, shifting
 * every later index — so a stored index would silently come to mean a different
 * Pokémon by the time the pick is made. Resolving by `uid` is immune to that,
 * and costs one opaque string on the wire.
 */
export type ChoiceTarget =
  | { side: PlayerSlot; zone: 'active' | number; uid: string }
  // 04.8 CP3-B: a deck card has no `uid` (uids belong to in-play Pokemon) and a
  // Deck can legally hold duplicates, so a card id would be ambiguous. A DECK
  // INDEX is stable for the whole life of the choice — nothing else can move a
  // card out of the Deck while `pendingChoice` blocks every other action — and
  // `cardId` is re-checked on resolve as a guard against any future change.
  | { side: PlayerSlot; zone: 'deck'; deckIndex: number; cardId: string }
  // 04.9 CP3: a card in a SIDE'S DISCARD PILE. Same reasoning as the deck variant —
  // a Deck may hold duplicates, so `cardId` is re-checked and the index is the
  // lookup. The discard is a PUBLIC zone, so the acting seat can already see it
  // (04.8 CP6's invariant, asserted in the harness).
  | { side: PlayerSlot; zone: 'discard'; index: number; cardId: string }
  // 04.10 CP5: a card in the actor's OWN HAND (054/150's "from your hand"). Same
  // index+id shape as the discard entry for the same reason — a hand holds DUPLICATES,
  // so `cardId` is re-checked on resolve and the index is the lookup. Unlike the
  // opponent's hand this is the VIEWER's own, so it discloses nothing new.
  | { side: PlayerSlot; zone: 'hand'; index: number; cardId: string }
  // 04.11 CP11 / 174: a choice between ENERGY TYPES, not between cards. "Discard all
  // basic Fire Energy OR all basic Lightning Energy" makes the player pick a type, and the
  // pick is not a card in any zone — so it is its own variant rather than a card target
  // with a fake zone, which would make the card-index lookup below meaningless.
  | { side: PlayerSlot; zone: 'energyType'; energyType: string }
  // 04.11 CP14 / 161: a specific Energy card ATTACHED to a specific in-play Pokemon.
  //
  // It is not a card in a zone — it is on a Pokemon — so it needs the owning `uid` as well
  // as an index. The index is into that Pokemon's `attachedEnergy` and it SHIFTS as cards
  // are discarded, which is why the target list is rebuilt after every pick rather than
  // stored once; `cardId` is re-checked on resolve for the same reason the deck and
  // discard targets carry it (a list of attachments is a list, and a stale index would
  // silently discard a DIFFERENT card than the player tapped).
  | { side: PlayerSlot; zone: 'attachedEnergy'; uid: string; index: number; cardId: string }
  // 04.11 CP16 / 182: a choice among SPECIAL CONDITIONS, not among cards. "…is now
  // Asleep, Confused, or Poisoned (your choice)" makes the player pick the condition, and
  // a condition is not a thing in a zone or on a Pokemon, so it needs its own variant.
  | { side: PlayerSlot; zone: 'statusCondition'; condition: StatusCondition }

/**
 * 04.8 CP2: an effect that the printed text hands to the player to resolve.
 *
 * This is the generalisation of the Knock Out promotion gate: the same three
 * steps — the engine parks a flag, `processAction` refuses every other action,
 * and the UI offers a `role="dialog"` picker. Deliberately inert in CP2-A: no
 * card text produces one yet, because a choice with no picker would soft-lock
 * the match. CP2-B wires the dialog and the first text atomically with it.
 */
/**
 * 04.10 CP4: take Basic Energy out of a ZONE and ATTACH it.
 *
 * Declared ONCE and referenced from both `ParsedEffect` and `PendingChoice`, because the
 * two must be the same shape — the second stage of the pick (`attachStaged`) carries a
 * copy as its `parent` and hands it straight back to re-park the pile. Two separately
 * written literals would drift, and the drift would only show up as a card silently
 * attaching one Energy instead of two.
 */
export type SearchAttachEnergyClause = {
  kind: 'searchAttachEnergy'
  /** 04.10 CP5 adds `'hand'` for 054/150; the other three read a pile. */
  from: 'deck' | 'discard' | 'hand'
  /** 042: Basic LIGHTNING Energy only. Undefined means any Basic Energy. */
  energyType?: string
  /**
   * Printed cap. Meaningless when `maxFromHeads` is set.
   *
   * 054/150 print "ANY number of", which is `Infinity` — and `Infinity` must NEVER
   * reach `remaining`, because `JSON.stringify(Infinity)` is `null` and would silently
   * break the snapshot round trip 04.8 CP6 established. The cap is therefore resolved to
   * the ELIGIBLE card count at park time, which is also the honest answer: you cannot
   * attach more Energy than you hold.
   */
  max: number
  /** 042: the cap is the heads flipped before the first tails, resolved at park time. */
  maxFromHeads?: boolean
  /**
   * How the destination Pokemon is chosen, and the whole of 007/042/063's difference:
   *  - 'attacker'   042 "attach it to THIS Pokemon" — no destination pick at all.
   *  - 'oneForAll'  063 "to 1 of your Pokemon"      — one destination for the whole set.
   *  - 'perCard'    007 "in any way you like"       — a destination per card.
   */
  target: 'attacker' | 'oneForAll' | 'perCard'
  /**
   * 04.10 CP5 / 054-150: the printed "You may", which is what makes the whole effect
   * declinable. 007/042/063 print no "may", so their absence of this flag is meaningful —
   * a choice that carries `optional` is one the player may refuse with `finishChoice`,
   * and a choice without it is a printed effect they may not skip.
   */
  optional?: boolean
}

export type PendingChoice = {
  /** The seat that must choose. Only this seat may resolve it. */
  actor: PlayerSlot
  /** Legal targets, in a stable order. Stored, not recomputed, so the list a
   *  player saw cannot drift from the list the engine validates against. */
  targets: ChoiceTarget[]
  /**
   * 04.9 CP4: how many MORE picks are allowed. **1** for every choice before this
   * checkpoint, which is why none of them had to change. "up to 2" sets 2, and a
   * player may stop early with `finishChoice` — "up to" is permissive, not a quota.
   *
   * Always a FINITE number, even for the printed "any number of" (053/149). The
   * cap is resolved at park time against what the deck and the Bench can actually
   * hold, which is what keeps `Infinity` off the wire: `JSON.stringify(Infinity)`
   * is `null`, so an unbounded `remaining` would silently fail the snapshot round
   * trip that 04.8 CP6 established.
   */
  remaining: number
  /**
   * 04.12 CP10 — whether resolving this choice ENDS the turn.
   *
   * **Every choice that existed before this field ended the turn**, because every one of
   * them was an ATTACK clause and attacking ends the turn. So the default is `true` and
   * it is read as `choice.endsTurn !== false` — one existing choice keeps its exact
   * behaviour without being touched, and a new caller opts IN to not ending the turn.
   *
   * 175 Solgaleo GX's "Ultra Road" is the first: *"Once during your turn (before your
   * attack), you may switch your Active Pokémon with 1 of your Benched Pokémon."* The
   * printed "before your attack" is load-bearing — the player still attacks afterwards —
   * so reusing the attack-path `switchActive` verbatim would have ended the turn on
   * activation and **silently removed the player's attack for the rest of the turn**.
   *
   * Carried verbatim by `applySnapshot` (it spreads the whole choice), so a guest sees
   * the same flag the host resolved against.
   */
  endsTurn?: boolean
  /** Which zone `targets` lives in, so the list can be re-derived after a pick. */
  source: 'deck' | 'discard' | 'hand' | 'inPlay'
  /**
   * 04.10 CP4: Energy already lifted out of its zone and waiting for a destination.
   *
   * A pick cannot both choose a card and choose where it goes, so the two are split
   * across two parked choices and the cards sit here in between. Without this buffer
   * the cards would have to be re-found by id, which is impossible: a Deck holds
   * DUPLICATES, so "the Lightning Energy I picked" is not an identity.
   *
   * It is copied out of the pile rather than referenced, because the pick SPLICES the
   * card out — holding the reference would leave a card that is in no zone at all.
   */
  staged?: CardDef[]
  /** What happens to the chosen target. */
  effect:
    | { kind: 'damage'; amount: number }
    // 04.8 CP2-C: "…for each damage counter on that Pokémon" — the amount is not
    // known until the target is picked, so it cannot be a flat number.
    | { kind: 'damagePerCounter'; amountPerCounter: number }
    // 04.8 CP3-B: move the chosen card out of the actor's own Deck.
    | { kind: 'searchDeck'; filter: 'pokemon' | 'trainer' | 'energy' }
    // 04.9 CP2: reduce the chosen Pokemon's damage to 0. `'all'` is the printed
    // "heal all damage", kept distinct from a number so a cap can never be
    // mistaken for a full heal.
    | { kind: 'healChosen'; amount: number | 'all' }
    // 04.9 CP3: move the chosen card from a SIDE'S DISCARD PILE somewhere else.
    // `to` is deliberately open: 'hand' and 'deck' land here, and a future 'bench'
    // needs no new effect kind, only a new target rule.
    | { kind: 'pickFromDiscard'; to: 'hand' | 'deck' }
    // 04.9 CP4: take up to N cards from a ZONE, resolving ONCE PER PICK. This is the
    // only effect kind that re-parks its own choice: `remaining` counts down and the
    // target list is rebuilt between picks, or `finishChoice` closes it early because
    // "up to" is permissive rather than a quota.
    //
    // `max` is the PRINTED cap and may be `Infinity` ("any number of"). It is never
    // the number enforced: `remaining` is resolved to a FINITE cap at park time,
    // because `JSON.stringify(Infinity)` is `null` and would break the round trip.
    //
    // 04.10 CP1 widened this from "the Deck" to "a zone, filtered". The three discard
    // families (048 energy→hand, 103 pokemon+energy→deck, 109/156 pokemon→Bench) differ
    // from 013/053/076 only in WHICH zone is read and WHICH cards qualify — a target
    // rule, not a new mechanism, which is exactly what 04.9 CP3 predicted when it left
    // `pickFromDiscard`'s `to` open for exactly this. A separate `searchDiscardUpTo`
    // would have been four near-identical kinds that can drift apart.
    | {
        kind: 'searchDeckUpTo'
        filter: 'basicPokemon' | 'stadium' | 'basicEnergy' | 'pokemon' | 'pokemonOrEnergy'
        to: 'hand' | 'bench' | 'deck'
        max: number
        /** Which zone the cards are taken FROM. 04.10 CP1; `'deck'` was the only value. */
        from: 'deck' | 'discard'
        /**
         * 04.10 CP1 / 109-156: put the picked Pokemon on the Bench. A Basic whose
         * printed type does not include the required type is not a legal target, and
         * the Bench cap (`MAX_BENCH`) still applies.
         */
        requireType?: string
      }
    | { kind: 'searchAnyToHand'; coin: boolean }
    /**
     * 04.10 CP4: the SECOND stage of a two-stage pick — choose which of your Pokemon
     * the already-chosen Energy attaches to.
     *
     * It is a choice effect rather than a flag on `searchAttachEnergy` because it is a
     * genuinely different question with a genuinely different target list (in-play
     * Pokemon, not cards in a pile), and the pending cards live on the choice itself
     * in `staged`. Keeping it separate is what lets 'attacker' (042) skip the second
     * stage entirely instead of parking a picker with exactly one legal entry.
     *
     * `parent` is the clause this stage was split out of, and it is NOT optional. The
     * first implementation dropped it, and 007 immediately broke in a way no parser
     * test could see: with the parent gone, stage two had no idea the remaining
     * `remaining` belonged to a per-card sequence, so it closed the turn after the
     * FIRST card and 007 could only ever attach one. Carrying the parent is what lets
     * 'perCard' re-park the pile and 'oneForAll' close.
     */
    | { kind: 'attachStaged'; parent: SearchAttachEnergyClause }
    // 04.10 CP4: take Basic Energy out of a ZONE and ATTACH it. This is NOT
    // `searchDeckUpTo` with a fourth `to` value, because the cards never move the
    // picked card to a pile — they attach it, and attaching has three different
    // destination rules that no `to` can express.
    //
    // `target` is the whole of that difference, and all three are needed:
    //  - 'attacker'   042 "attach it to THIS Pokemon" — no pick at all.
    //  - 'oneForAll'  063 "to 1 of your Pokemon"      — one destination, chosen once.
    //  - 'perCard'    007 "in any way you like"       — a destination per card.
    //
    // `maxFromHeads` is 042's cap: "up to the number of heads" from a flip-until-tails,
    // so the cap is not knowable at parse time. It is resolved at park time, and the
    // resolved number is what goes into `remaining` — never a stale or invented cap.
    | SearchAttachEnergyClause
    /**
     * 04.10 CP8b / 115 Ditto: the second stage of a transform — the actor picks the
     * Basic Pokemon that REPLACES the attacker's card.
     *
     * It is a choice rather than a flag because the destination is the whole point: the
     * picked card becomes the Active's new face while the attacker's OWN state
     * (attachments, damage, Special Conditions, turns in play) stays exactly where it
     * is. That INVERTS `applySwitchInPlace`, which moves an object along with its own
     * state, so it cannot be reused and needs its own kind.
     */
    | { kind: 'transformFromDeck' }
    /**
     * 04.11 CP11 / 174 — the FIRST deferred-damage effect.
     *
     * The printed text is "Discard all basic Fire Energy or all basic Lightning Energy
     * attached to this Pokemon. This attack does 60 damage times the number of Energy
     * cards you discarded." The damage is a function of a count that only exists AFTER a
     * choice, and `resolveAttack` fixes damage at step 2 while choices park at step 5 —
     * so the damage cannot be computed in the usual order at all.
     *
     * This choice therefore DISCARDS and DEALS in one step, and `resolveAttack` skips its
     * own damage entirely for a card carrying this kind. `perCard` is the printed 60.
     */
    | { kind: 'discardEnergyTypeThenTimesDamage'; types: string[]; perCard: number }
    /**
     * 04.11 CP14 / 161 — the multi-pick deferred damage.
     *
     * "You may discard as many Energy cards as you like attached to your Pokemon in play.
     * If you do, this attack does 30 damage plus 20 more damage for each Energy card you
     * discarded."
     *
     * `remaining` is the "as many as you like" allowance, resolved at park time to a
     * FINITE count (every Energy attached to the actor's Active and Bench), because an
     * unbounded `remaining` would serialise to `null` and break the snapshot round trip.
     * "You may" makes the whole thing declinable, so `finishChoice` is legal and deals
     * `base` alone.
     *
     * Picked cards are spliced into `staged` and only reach the discard pile when the
     * sequence ENDS, so `staged.length` is the count the damage is a function of. This is
     * what `staged` is for — 04.10 CP4 splices cards out for exactly the same reason — and
     * it means a half-finished sequence can never leave cards in no zone at all.
     */
    | { kind: 'discardAttachedEnergyThenBonusDamage'; base: number; perCard: number }
    /**
     * 04.11 CP15 / 180 — "You may move all Energy cards attached to Palkia to your Benched
     * Pokemon in any way you like."
     *
     * **This is the one deferred-damage sibling that needs NO deferral**: 180 prints 60, so
     * the damage is ordinary and the move is an ordinary choice. What makes it a multi-pick
     * is "in any way you like" — the player picks a DESTINATION per card, so the sequence
     * runs once per card exactly like 04.10 CP4's `perCard` attach.
     *
     * `remaining` counts the cards still to move. There is no cursor for WHICH card: every
     * card moves eventually, so the order is immaterial and the next card is simply the
     * last one still attached. Only the DISTRIBUTION is the player's choice, which is
     * exactly what the text grants.
     *
     * The printed parenthetical — "(Ignore this effect if you don't have any Benched
     * Pokemon.)" — is folded in rather than modelled separately; see the parser.
     */
    | { kind: 'moveAttachedEnergyToBench' }
    /**
     * 04.11 CP16 / 182 — "Flip a number of coins equal to the number of Energy attached to
     * the Defending Pokemon. If you get 1 or more heads, the Defending Pokemon is now
     * Asleep, Confused, or Poisoned (your choice)."
     *
     * The flips have ALREADY happened by the time this is offered — the applier resolves
     * them and only parks this when at least one was heads — so the choice is purely WHICH
     * condition to apply, and `conditions` is exactly the list the text names.
     */
    | { kind: 'chooseStatusCondition'; conditions: StatusCondition[] }
    /**
     * 04.10 CP5 / 073-136: "You may shuffle this Pokemon and all attached cards into your
     * deck."
     *
     * A choice, not a flag, despite there being nothing to CHOOSE — the printed "You may"
     * is a permission, and applying it automatically would be a *stronger* effect than the
     * card prints, which is the wrong-effect failure this engine ranks above a missing
     * one. The single target is the attacker, so the dialog offers exactly one entry and
     * `finishChoice` declines it, which is the same shape 04.9 CP7 gave 066/152/158's
     * optional switch.
     *
     * The plan predicted this would need "a per-card target pick". It does not: the text
     * says "THIS Pokemon", so there is no target to pick and nothing to choose between.
     */
    | { kind: 'shuffleSelfIntoDeck'; optional: boolean }
    // 04.9 CP7: swap the chosen Pokemon with the current Active of that side. The whole
    // `InPlayPokemon` object moves, so Energy, damage, conditions and the uid travel
    // with it — see `applySwitchInPlace`. `optional` is 066/152/158's printed "You may",
    // which is what lets `finishChoice` decline it; 032's mandatory swap has it false.
    | { kind: 'switchActive'; side: 'attacker' | 'defender'; optional: boolean }
    /**
     * 04.12 CP11 / 158 Intrepid Sword, stage ONE: lift a card off the top of the deck.
     *
     * A genuinely new source rather than a `searchDeckUpTo` variant with a flag: the
     * printed "look at the TOP 3" exposes a FIXED window, so the target list is
     * `deck[0..look-1]` and must NOT be re-searched for a match anywhere in the deck. That
     * is why it parks its own kind instead of widening `searchDeckUpTo`'s `from` — a flag
     * there would have made "top 3" and "anywhere in the deck" one clause with a boolean,
     * which is exactly the shape that gets mis-set once.
     *
     * **`userUid` is REQUIRED, not a convenience.** The ability's own Pokemon is the
     * destination, and it cannot be recovered later: `resolveChoice` holds only the choice,
     * and re-deriving "whose ability was this" from the log or the turn order is exactly the
     * inference that silently attaches to the wrong Pokemon when both players use abilities
     * in the same turn.
     *
     * **`taken` counts how much of the top-N window has already been lifted.** It is the
     * ONLY correct way to track the window, and the reason is worth stating because the
     * obvious alternative looks fine and is not: after lifting the card at deck index 0, the
     * next "top 3" starts where index 3 used to be. Recomputing the window from a stored
     * index silently re-offers a card that is no longer in it and under-offers a card that
     * is — so the window is a COUNTER, not a position.
     */
    | { kind: 'takeTopOfDeck'; look: number; attachTo: 'self'; energyType: string; userUid: string; taken: number }
    /**
     * 04.12 CP11 / 097 Starmie, stage ONE: discard a matching Energy from hand. Stage two
     * is `placeCountersOnChosen` below. Kept as two kinds rather than one with a phase
     * counter, so `resolveChoice` has no "am I on stage one?" branch to get wrong.
     */
    | { kind: 'discardEnergyFromHand'; energyType: string; counters: number }
    /**
     * 04.12 CP11 / 097 Starmie, stage TWO: put the counters on the chosen Pokemon.
     *
     * COUNTERS, not damage, because the card prints "6 damage counters" and the engine's
     * only counter unit is `DAMAGE_PER_COUNTER`. Weakness therefore does NOT apply, which
     * is the printed reading of a counter and differs from an attack's damage — the same
     * distinction `countersOnAttackerWhenDamaged` already draws.
     */
    | { kind: 'placeCountersOnChosen'; counters: number }
    /**
     * 04.12 CP12 / 100 Pidgeot "Red Signal": move the OPPONENT's chosen Benched Pokemon in
     * as their Active, replacing theirs.
     *
     * A separate kind from `switchActive`, which moves the ACTING seat's own board. The two
     * look alike and are deliberately not merged: one target is the actor's Bench and the
     * other is the OPPONENT's Bench, and a shared arm that picked the wrong side would move
     * the wrong Pokemon rather than fail.
     */
    | { kind: 'switchFoeBenchWithActive' }
  /** Printed attack that asked for the choice, for the log line. */
  attackName: string
}

export type InPlayPokemon = {
  uid: string
  card: PokemonCardDef
  damage: number
  /** Attached Energy cards (not ids) so attack costs can read `provides`. */
  attachedEnergy: EnergyCardDef[]
  /** Single Pokemon Tool attachment (CP4 action model; CP6 renders it). */
  attachedTool: TrainerCardDef | null
  conditions: SpecialConditionState
  /**
   * 04.11 CP6 / 169: damage COUNTERS this Pokemon's Poison deals between turns.
   *
   * The rulebook default is 1, and every other card leaves it alone — so this is `1`
   * everywhere except the one card that prints otherwise. 169 ("Put 2 damage counters
   * instead of 1") is the only card in the set that changes the number, and it changes it
   * as a property OF THE POISONED POKEMON rather than as a damage modifier, so it cannot
   * ride `durationDamageAdjustment` (which is a flat damage offset, not a multiplier of
   * the poison tick).
   */
  poisonCounters: number
  enteredTurn: number
  evolvedTurn: number
  energyAttachedTurn: number
  retreatedTurn: number
  /** Turn number this copy last used its Ability. */
  abilityUsedTurn: number
  /**
   * 04.10 CP3: attack damage this Pokemon took, stamped with the TURN it happened on
   * (`lastTurnAttackedTurn`) and the amount for that turn. Read by 085/138 Lycanroc's
   * "if this Pokemon was damaged by an attack during your opponent's last turn, this
   * attack does that much more damage".
   *
   * Stored as a TURN NUMBER, not as a counter to clear, and that is the whole trick.
   * The read is `lastTurnAttackedTurn === state.turn - 1`, so a hit from two turns ago
   * can never be mistaken for a hit last turn and there is no "forgot to reset" bug to
   * have. Clearing a counter instead would need a correct reset on EVERY path that ends
   * a turn, and 04.9 already found `applyEndTurn` has more than one exit.
   */
  lastTurnAttackedTurn: number
  /** Attack damage dealt to this Pokemon on `lastTurnAttackedTurn`. */
  lastTurnAttackedAmount: number
}

export type SideState = {
  deck: CardDef[]
  hand: CardDef[]
  active: InPlayPokemon | null
  bench: InPlayPokemon[]
  prizes: CardDef[]
  prizeCount: number
  discard: CardDef[]
  lostZone: CardDef[]
  /** True once a Supporter was played this turn (rulebook: one per turn). */
  supporterPlayedTurn: boolean
  /** Energy cards attached this turn (rulebook: one Energy card per turn). */
  energyAttachedThisTurn: number
  /** True once this side declared an attack this turn. */
  attackedThisTurn: boolean
  /** Turn number a Stadium was played on, or -1 when none. */
  stadiumPlayedTurn: number
  /** Once-per-side Retreat marker for the current turn. */
  retreatedThisTurn: boolean
  /** Number of opening-hand Mulligans. The opponent chooses the extra-card penalty. */
  mulliganCount: number
  /**
   * Every opening hand this side had to Mulligan away, oldest first.
   *
   * Rulebook (Setting Up to Play): "Reveal your hand to your opponent to
   * prove you have no Basic Pokémon", so these are PUBLIC to both seats — they
   * are deliberately not hidden like `hand`. The history (rather than just a
   * count) is kept because the reveal happens on every Mulligan, not once.
   */
  mulliganedHands: CardDef[][]
  /** Ability names used this turn by this side, for once-per-name restrictions. */
  abilityUsedNames: Record<string, number>
  /**
   * 04.12 CP12 / 100 Rayquaza VSTAR "Starbirth": "(You can't use more than 1 VSTAR Power in
   * a game.)"
   *
   * **PER GAME, not per turn**, which is why it cannot reuse `abilityUsedTurn` or
   * `abilityUsedNames` — both are keyed on `turn` and would silently reset at Between-Turns,
   * making the restriction "once per turn" and letting a player use two VSTAR Powers.
   *
   * A boolean rather than a count: the printed cap is exactly 1, so a number would carry an
   * unrepresentable state (>1 is unreachable) for no gain.
   *
   * Persisted on the SIDE, not on the Pokemon, because "a game" outlives any one card — a
   * Rayquaza that leaves play must not hand the Power back.
   */
  vstarPowerUsedThisGame: boolean
  /** Face-down setup Active selected from this side's private hand. */
  setupActive: PokemonCardDef | null
  /** Face-down setup Bench selected from this side's private hand. */
  setupBench: PokemonCardDef[]
  /** Extra cards this player elected to take after the opponent Mulliganed. */
  setupPenaltyCards: number
  /** True after this side's Active/Bench/Prize selection is locked. */
  setupReady: boolean
  /**
   * 04.10 CP3: the turn on which one of THIS side's Pokemon was Knocked Out BY AN
   * ATTACK, or -1 when none has. Read by 005 Tropius / 091 Umbreon's "if any of your
   * Pokemon were Knocked Out by damage from an attack during your opponent's last
   * turn, this attack does N more damage".
   *
   * Deliberately a SIDE field, not a per-Pokemon one, for a decisive reason: a
   * knocked-out Pokemon's `InPlayPokemon` object is destroyed by `discardKnockedOut`,
   * which keeps only the `CardDef`. A flag on the Pokemon would therefore be gone
   * exactly when the clause needs it, and the clause is side-wide ("any of your
   * Pokemon") anyway, so the side is the only place the memory can live.
   *
   * Stamped with a TURN rather than cleared, for the same anti-compounding reason as
   * `InPlayPokemon.lastTurnAttackedTurn`: the read is `=== state.turn - 1`, so an old
   * KO ages out on its own. This also means `applyEndTurn` needs no reset step — which
   * matters because 04.9 found it has more than one exit, and a flag that had to be
   * cleared on each would eventually be missed.
   *
   * Recorded ONLY for damage from an attack. Poison and Burn KOs run through the same
   * `performKo`, so the flag is set at the attack sites and never inside `performKo`
   * itself — 04.10's text is specific about "by damage from an attack", and a
   * Between-Turns poison KO satisfying it would be a wrong effect.
   */
  koByAttackTurn: number
  /**
   * 04.12 CP12 / 083 Charizard "Energy Burn": "you may turn all Energy attached to
   * Charizard into Fire Energy FOR THE REST OF THE TURN."
   *
   * **"For the rest of the turn" is the whole rule, and it is why this is an override and
   * not a mutation.** Burning the cards in place would make it permanent; the printed text
   * expires it, so the cards are left untouched and this READS as `fire` for every Energy
   * check until the turn ends. Storing it is what makes the expiry guaranteed rather than
   * merely intended.
   *
   * Keyed by `uid`, never by position: a switch moves the Pokemon, so an override that
   * followed a slot would apply to whichever Pokemon arrived there next.
   *
   * `turn` is carried so a rebuilt snapshot can tell whether the override is live rather
   * than trusting a stale flag from a turn that has since ended.
   */
  energyTypeOverride: { uid: string; provides: string; turn: number }[]
}

/**
 * Log entries stay structured (a translation key plus raw data params) so the
 * battle-log strip can translate the template while card names stay verbatim
 * data. Keys are `pokemonBnb.log.*`, added to en/ms/zh in CP7-E and
 * extended with setup events by CP3.
 */
export type BattleLogEntry = { key: string; params?: Record<string, string | number> }

export type BattleState = {
  host: SideState
  guest: SideState
  activePlayer: PlayerSlot
  /** Turn counter; turn 1 is the first player's opening turn. */
  turn: number
  phase: TurnPhase
  winner: PlayerSlot | null
  winReason: 'prizes' | 'deck-out' | 'no-pokemon' | null
  over: boolean
  seed: number
  prizeCards: number
  timerSeconds: number
  setup: SetupPlayerState
  /** Shared Stadium currently in play, or null. */
  stadium: TrainerCardDef | null
  /** Ordered promotion queue; simultaneous KOs enqueue next player first. */
  promotionQueue: PlayerSlot[]
  /** Side that must choose a new Active after a KO before anything else. */
  pendingPromotion: PlayerSlot | null
  /**
   * 04.8 CP2: a printed effect awaiting the actor's target pick. Inert in
   * CP2-A — no card text produces one yet, because a choice with no picker would
   * soft-lock the match. CP2-B wires the dialog and the first text together.
   */
  pendingChoice: PendingChoice | null
  /**
   * 04.9 CP5: live time-limited effects ("during your next turn…"). This is the
   * FIRST field 04.9 adds to the wire, and it names no hidden zone — a duration
   * carries a `uid`, an effect and a turn number, never a card the seat cannot see
   * — so it discloses nothing the two seats do not already both know.
   */
  durations: ActiveDuration[]
  /** True once the current turn's start step (draw + flag reset) has run. */
  turnStarted: boolean
  /**
   * True for a state rebuilt from a `Snapshot` (guest render model): hidden
   * zones hold placeholders, so `processAction` refuses to run on it.
   */
  viewOnly: boolean
  log: BattleLogEntry[]
  rngDraws: number
}

export type SnapshotSide = {
  handCount: number
  /**
   * 04.8 CP3: the VIEWER's own deck, as real cards, so a "Search your deck…"
   * effect can offer real targets. The other seat's snapshot carries
   * `HIDDEN_CARD` placeholders here instead — this is the one place the privacy
   * boundary is a per-snapshot property rather than a global one.
   */
  deck: CardDef[]
  deckCount: number
  prizesTaken: number
  prizeCount: number
  discard: CardDef[]
  active: InPlayPokemon | null
  bench: InPlayPokemon[]
  hand: CardDef[] | null
  mulliganCount: number
  /** Public to both seats: the rulebook requires a failed hand to be revealed. */
  mulliganedHands: CardDef[][]
  setupActiveCount: number
  setupBenchCount: number
  setupPenaltyCards: number
  setupReady: boolean
  /**
   * 04.10 CP3: the SIDE half of the "opponent's last turn" memory, carried verbatim
   * like `durations`. It is public information — both players watched the Knock Out
   * happen — and the rebuilt state is `viewOnly`, so it exists purely so a rebuilt
   * state reads the same 005/091 answer the host computes. It names no hidden zone,
   * so the privacy boundary is unchanged.
   */
  koByAttackTurn: number
}

export type Snapshot = {
  activePlayer: PlayerSlot
  turn: number
  phase: TurnPhase
  winner: PlayerSlot | null
  winReason: BattleState['winReason']
  over: boolean
  prizeCards: number
  timerSeconds: number
  pendingPromotion: PlayerSlot | null
  promotionQueue: PlayerSlot[]
  /** 04.8 CP2: carried verbatim so the guest renders the same picker the host
   *  sees. It names no hidden zone, so this is NO privacy change — the deck and
   *  the opponent's hand stay hidden, which is why deck search stays a separate,
   *  still-blocked decision. */
  pendingChoice: PendingChoice | null
  /**
   * 04.12 CP12: the per-side boards the snapshot carries, including the new once-per-game
   * VSTAR marker and the turn-scoped Energy-type override. Both are PUBLIC (a player knows
   * their own Power is spent and what their own Energy became), so neither names a hidden
   * zone and the privacy boundary is unchanged.
   */
  sideOverrides: {
    vstarPowerUsedThisGame: boolean
    energyTypeOverride: { uid: string; provides: string; turn: number }[]
  }[]
  /**
   * 04.9 CP5: the same live durations, carried verbatim so the guest's board
   * renders the same locks and damage modifiers the host applies. Read-only for
   * the guest: a rebuilt state is `viewOnly`, so only the host ever expires one.
   */
  durations: ActiveDuration[]
  stadium: TrainerCardDef | null
  turnStarted: boolean
  setup: SetupPlayerState
  log: BattleLogEntry[]
  host: SnapshotSide
  guest: SnapshotSide
}

/**
 * 04.9 CP5: what a time-limited effect DOES while it is live.
 *
 * These are deliberately separate from `STATUS_CONDITIONS`: a Special Condition
 * lives on the Pokemon and is cleared by the engine's own Between-Turns rules,
 * whereas a duration is a *printed card clause* with an explicit expiry. Folding
 * one into the other would make "Asleep" (which ends by a coin flip) and
 * "can't attack this turn" (which ends when the named turn ends) indistinguishable.
 */
export type DurationEffect =
  /** 060/134/064/151/157 — "this Pokemon can't use attacks". */
  | { kind: 'cantAttack' }
  /**
   * 106 — the same lock narrowed to ONE named attack. `attackName` is the printed
   * attack name, matched verbatim; an unrecognised name is a no-op rather than a
   * guess, so a typo can never lock a Pokémon out of every attack.
   */
  | { kind: 'cantUseAttack'; attackName: string }
  /** 079/107 — "this Pokemon takes N less damage", applied AFTER Weakness/Resistance. */
  | { kind: 'lessDamageTaken'; amount: number }
  /**
   * 04.10 CP2 / 087 Nidoran — the MIRROR of `lessDamageTaken`, and the reason a
   * SECOND effect kind is needed rather than a flag on the first. 028 reduces what
   * the holder TAKES (read on the defender); this reduces what the holder DEALS
   * (read on the attacker). One signed field would let the two directions be
   * confused, which is a wrong effect rather than a stricter one.
   */
  | { kind: 'lessDamageDealt'; amount: number }
  /** 110 — "the Defending Pokemon takes N more damage", AFTER Weakness/Resistance. */
  | { kind: 'moreDamageTaken'; amount: number }
  /** 006/016/044 — "prevent all damage from and effects of attacks". */
  | { kind: 'preventAllDamage' }
  /** 093 — "the Defending Pokemon can't retreat". */
  | { kind: 'cantRetreat' }
  /**
   * 04.10 CP8 / 040 Pikachu: "The Defending Pokemon's Weakness is now Lightning until
   * the end of your next turn. (Apply Weakness as x2.)"
   *
   * A Weakness MUTATION, not a damage modifier, which is why it is a duration riding
   * the DEFENDER rather than a `reducedBase` term: the printed Weakness TABLE is
   * replaced for the whole window, so anything reading the defender's weaknesses — not
   * only this one attack — sees Lightning. `multiplier` carries the printed "as x2" so
   * a card printing another value is read rather than assumed.
   */
  | { kind: 'weaknessChange'; type: string; multiplier: number }
  /**
   * 04.10 CP8 / 084 Seismitoad: "whenever they try to use a Trainer card from their
   * hand, they flip a coin. If tails, your opponent discards that Trainer card
   * instead of using it."
   *
   * It rides the HOLDER (the Seismitoad), not the opponent: the action it intercepts
   * is the OPPONENT's, so the gate is read from whichever seat is acting. Tails
   * DISCARDS the card and the play does not happen, which is different from a play that
   * failed to resolve — the card is spent either way, and the discard is what changes.
   */
  | { kind: 'interceptTrainer' }

/**
 * 04.9 CP5: one live time-limited effect, riding a specific in-play Pokemon.
 *
 * **`activeTurn` is an ABSOLUTE engine turn number, and that is the whole
 * expiry mechanism.** The engine's `turn` counter advances by exactly one per
 * `applyEndTurn`, and the two seats strictly alternate, so "your next turn" and
 * "your opponent's next turn" are both just a number: from turn T, the opponent's
 * next turn is T+1 and the actor's own is T+2. Storing the number rather than a
 * `(seat, relativeOffset)` pair means expiry needs no seat bookkeeping and cannot
 * drift when the two disagree.
 *
 * The Pokemon is named by `uid`, never by a zone index — 04.8 CP2-C established
 * that a promotion splices the Bench and shifts every later index, so a stored
 * index would silently come to mean a different Pokémon. A duration on a
 * Knocked-Out Pokémon simply stops applying, because its uid is no longer in play.
 */
export type ActiveDuration = {
  /**
   * Deterministic identity: `<uid>:<effectKind>[:<argument>]`. Applying the same
   * printed clause twice for the same Pokemon in the same window REPLACES rather
   * than stacks, which is what makes a re-resolved attack idempotent instead of
   * doubling a "-60 damage" modifier.
   */
  id: string
  /** The in-play Pokemon this rides, by uid. */
  uid: string
  effect: DurationEffect
  /** The engine turn this is live for; pruned once `state.turn` passes it. */
  activeTurn: number
  /** Card name that created it, so the log and the UI can name the source. */
  sourceName: string
}

export type BattleAction =
  | { type: 'chooseTurnOrder'; firstPlayer: PlayerSlot }
  | { type: 'keepSetupHand' }
  | { type: 'mulliganSetup' }
  | { type: 'chooseSetupPokemon'; activeHandIndex: number; benchHandIndexes: number[]; penaltyCards: number }
  | { type: 'confirmSetupReveal' }
  | { type: 'attachEnergy'; handIndex: number; target: 'active' | number }
  | { type: 'playBasic'; handIndex: number }
  | { type: 'playTrainer'; handIndex: number }
  | { type: 'attachTool'; handIndex: number; target: 'active' | number }
  | { type: 'useAbility'; target: 'active' | number; abilityIndex: number; targetIndex?: 'active' | number }
  | { type: 'evolve'; handIndex: number; target: 'active' | number }
  | { type: 'retreatToBench'; benchIndex: number }
  | { type: 'beginAttack' }
  | { type: 'pass' }
  | { type: 'useAttack'; attackIndex: number }
  | { type: 'promoteActive'; benchIndex: number }
  /** 04.8 CP2: resolve the pending choice by INDEX into its stored target list,
   *  never a forged zone — the engine re-validates the entry it already agreed. */
  | { type: 'chooseTarget'; targetIndex: number }
  /** 04.9 CP4: stop a multi-pick early. "Up to 2" is permissive, so declining the
   *  second pick is a legal outcome and not a way to skip the effect. */
  | { type: 'finishChoice' }

export type ActionResult = { state: BattleState; log: BattleLogEntry[]; error?: string }
