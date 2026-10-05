/**
 * 04.11 CP19: WHICH template a choice-target button uses, as a pure function.
 *
 * **This logic was a nine-deep ternary buried in JSX for most of 04.11**, which is why it
 * could never be checked: CP12 proved the rendering *guard* by evaluating the boolean
 * directly, and noted at the time that a boolean is free to test exhaustively but this one
 * was unreachable. Extracting it into a module with NO React import is what makes it
 * checkable at all — a harness that pulled in the component would drag JSX, CSS and the
 * DOM into a Node process, and the project has no test runner to hide that behind.
 *
 * `shape` is what the TARGET is — derived once by the caller — and `effectKind` is the
 * parked clause. `usesName` says whether the template takes `{name}`; the damage
 * templates take `{amount}` instead, which is why they are a `null` fallthrough rather
 * than a default: a choice that is not damage must never fall through to "Deal 0 damage
 * to X", which is a wrong label rather than a blank one.
 */
export type ChoiceTargetShape = 'energyType' | 'statusCondition' | 'attachedEnergy' | 'looseCard' | 'inPlay'

export function choiceTemplateKey(
  shape: ChoiceTargetShape,
  effectKind: string,
  /**
   * 04.12 CP9 F3: the NAME OF THE POKEMON the attached Energy sits on.
   *
   * 161's picker offered three buttons reading "Discard this Lightning Energy" and two
   * reading "Discard this Metal Energy", with nothing naming WHICH Pokemon each one is on
   * — so the list was unresolvable without reading the board. This is the one label that
   * needs it, and it is passed in rather than looked up here so this module stays free of
   * battle state (the reason it was extracted from JSX in the first place).
   */
  attachedHolderName?: string,
  /**
   * 04.12 CP9 F3 (second pass): the SLOT NUMBER of the attached Energy on that Pokemon.
   *
   * **Naming the holder was NOT enough, and the QA screenshot is what proved it.** 161's
   * five Energy were all attached to Metagross, so "Discard this Lightning Energy from
   * Metagross" appeared three times and "Metal Energy from Metagross" twice — the holder
   * is identical across all five, and duplicates in one attachment list are the same card,
   * so there is no name to tell them apart. The INDEX is the only honest identity the
   * engine has: it re-resolves by index and re-checks `cardId`, which is precisely because
   * a list of attachments has no stable per-card identity.
   *
   * Passed in, not derived, so this module still holds no battle state. Only supplied when
   * the holder has more than one attachment — a lone "#1" is noise, not information.
   */
  attachedSlot?: string,
): { key: string; usesName: boolean } | null {
  // These three are identified by the TARGET, not the clause: 161/174/180/182 each park a
  // choice whose shape is what distinguishes it, so a clause that means something else
  // must never steal the label.
  if (shape === 'energyType') return { key: 'pokemonBnb.chooseEnergyTypeAction', usesName: false }
  if (shape === 'attachedEnergy') {
    // With a known holder, name it. Without one, fall back to the bare card name rather
    // than printing an empty "from " — a blank slot reads as a rendering fault.
    return attachedSlot
      ? { key: 'pokemonBnb.chooseDiscardAttachedSlotAction', usesName: true }
      : attachedHolderName
        ? { key: 'pokemonBnb.chooseDiscardAttachedFromAction', usesName: true }
        : { key: 'pokemonBnb.chooseDiscardAttachedAction', usesName: true }
  }
  if (shape === 'statusCondition') return { key: 'pokemonBnb.chooseConditionAction', usesName: true }
  if (shape === 'looseCard') return { key: '', usesName: true }
  // inPlay targets: the clause decides, because a Pokemon target can be a heal, an attach,
  // a switch, a return-to-deck, an Energy destination, or a plain victim.
  if (effectKind === 'moveAttachedEnergyToBench') return { key: 'pokemonBnb.chooseMoveEnergyAction', usesName: true }
  if (effectKind === 'healChosen') return { key: 'pokemonBnb.chooseHealAction', usesName: true }
  if (effectKind === 'attachStaged') return { key: 'pokemonBnb.chooseAttachHereAction', usesName: true }
  if (effectKind === 'shuffleSelfIntoDeck') return { key: 'pokemonBnb.chooseShuffleSelfAction', usesName: true }
  // 04.12 CP20 / 168: the same single-target confirm as 073/136, so it reuses that prompt
  // rather than inventing a near-identical string. The wording "shuffle" would be wrong
  // here, so it gets its own key.
  if (effectKind === 'returnSelfAndAttachmentsToDeckBottom') return { key: 'pokemonBnb.chooseDeckBottomAction', usesName: true }
  if (effectKind === 'switchActive') return { key: 'pokemonBnb.chooseSwitchAction', usesName: true }
  return null // damage / per-counter: the caller keeps its existing amount templates
}

/**
 * 04.12 CP9 F2: WHICH log line a parked choice announces, as a pure function.
 *
 * **The bug this fixes:** every choice kind emitted `pokemonBnb.log.chooseTarget`, whose
 * English text is *"{player} must choose 1 of {count} Pokemon in play."* That sentence is
 * true for 180 (spread damage onto a Pokemon) and FALSE for the other three — 161 announces
 * five ATTACHED ENERGY cards, 174 two ENERGY TYPES, and 182 three STATUS CONDITIONS, none
 * of which is a Pokemon in play. So the log asserted a target type the printed clause never
 * mentions, on 3 of the 4 dialogs the QA pass screenshotted.
 *
 * Shape is read from the TARGETS rather than the clause, for the same reason
 * `choiceTemplateKey` does: `discardAttachedEnergyThenBonusDamage` and
 * `discardEnergyTypeThenTimesDamage` are different clauses that happen to both be
 * "discard something", and only the target knows what the player is actually picking.
 *
 * The count is deliberately NOT a parameter. It is `targets.length` at every call site,
 * so passing it separately only created a way for the two to disagree.
 */
export function choiceLogKey(choice: {
  targets: readonly { zone: string | number }[]
}): string {
  // A NUMBER means a Bench index (an in-play Pokemon), so it falls through to the
  // default. Comparing it against 'deck' with `===` is false, but this is written as an
  // explicit typeof guard so the next reader does not have to know that.
  const zone = choice.targets[0]?.zone
  if (typeof zone !== 'string') return 'pokemonBnb.log.chooseTarget'
  if (zone === 'attachedEnergy') return 'pokemonBnb.log.chooseAttachedEnergy'
  if (zone === 'energyType') return 'pokemonBnb.log.chooseEnergyType'
  if (zone === 'statusCondition') return 'pokemonBnb.log.chooseStatusCondition'
  if (zone === 'deck') return 'pokemonBnb.log.chooseDeckCard'
  if (zone === 'hand') return 'pokemonBnb.log.chooseHandCard'
  if (zone === 'discard') return 'pokemonBnb.log.chooseDiscardCard'
  return 'pokemonBnb.log.chooseTarget'
}
