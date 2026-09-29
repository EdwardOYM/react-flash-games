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
): { key: string; usesName: boolean } | null {
  // These three are identified by the TARGET, not the clause: 161/174/180/182 each park a
  // choice whose shape is what distinguishes it, so a clause that means something else
  // must never steal the label.
  if (shape === 'energyType') return { key: 'pokemonBnb.chooseEnergyTypeAction', usesName: false }
  if (shape === 'attachedEnergy') return { key: 'pokemonBnb.chooseDiscardAttachedAction', usesName: true }
  if (shape === 'statusCondition') return { key: 'pokemonBnb.chooseConditionAction', usesName: true }
  if (shape === 'looseCard') return { key: '', usesName: true }
  // inPlay targets: the clause decides, because a Pokemon target can be a heal, an attach,
  // a switch, a return-to-deck, an Energy destination, or a plain victim.
  if (effectKind === 'moveAttachedEnergyToBench') return { key: 'pokemonBnb.chooseMoveEnergyAction', usesName: true }
  if (effectKind === 'healChosen') return { key: 'pokemonBnb.chooseHealAction', usesName: true }
  if (effectKind === 'attachStaged') return { key: 'pokemonBnb.chooseAttachHereAction', usesName: true }
  if (effectKind === 'shuffleSelfIntoDeck') return { key: 'pokemonBnb.chooseShuffleSelfAction', usesName: true }
  if (effectKind === 'switchActive') return { key: 'pokemonBnb.chooseSwitchAction', usesName: true }
  return null // damage / per-counter: the caller keeps its existing amount templates
}
