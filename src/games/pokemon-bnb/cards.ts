// Card data model for Pokemon TCG B&B mini. Types only + tiny pure helpers:
// no React, no DOM. Card content (names, HP, attacks) lives in
// src/assets/pokemon-bnb/sets/<set>/cards.json and is data, not UI chrome —
// it renders verbatim inside components and is never routed through t().

export type SetId = string
export type CardRarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'double rare'
  | 'illustration rare'
  | 'pikachu rare'
  /** 30c 159-188: classic-era reprints, the 1-in-10 pack chase. */
  | 'classic rare'
  | 'special illustration rare'
  | 'futuristic rare'
export type CardSupertype = 'pokemon' | 'trainer' | 'energy'
export type CardType = 'grass' | 'fire' | 'water' | 'lightning' | 'psychic' | 'fighting' | 'darkness' | 'metal' | 'dragon' | 'colorless'
export type EnergyCategory = 'normal' | 'special'

export type AttackDef = {
  name: string
  /** Energy-type symbols required, in order; colorless is wild. */
  cost: CardType[]
  damage: number
  /** Verbatim card text for non-damage or special effects. */
  text: string
}

export type AbilityDef = {
  name: string
  text: string
  type: string
}

export type WeaknessDef = { type: CardType; value: string }
export type ResistanceDef = { type: CardType; value: string }

export type PokemonCardDef = {
  id: string
  set: SetId
  number: string
  name: string
  rarity: CardRarity
  /**
   * The printed rule box, from the TCGdex `suffix` field — e.g. `"EX"` for a
   * Pokémon ex. It is the ONLY data-backed way to know a card's rule box: the
   * upstream API has no `ruleBox` field, and 30c carries no `evolvesFrom`
   * either, so this follows the same "use the real field, not the name" rule
   * (see `prizesForKnockOut`, which reads this).
   *
   * Deliberately stored as the raw upstream string rather than a closed union:
   * the values in circulation (EX, MEGA EX, and whatever else) are not
   * enumerated anywhere in this repo, so narrowing them here would encode a
   * guess. Absent on ordinary cards.
   */
  suffix?: string
  supertype: 'pokemon'
  types: CardType[]
  hp: number
  stage: string
  evolvesFrom?: string
  retreat: number
  weaknesses: WeaknessDef[]
  resistances: ResistanceDef[]
  attacks: AttackDef[]
  abilities: AbilityDef[]
  /** Guaranteed Pikachu illustration-rare slot number (1..30 for 30C). */
  irVariation?: number
  illustrator?: string
}

export type TrainerCardDef = {
  id: string
  set: SetId
  number: string
  name: string
  rarity: CardRarity
  supertype: 'trainer'
  types: []
  trainerType: string
  /** Verbatim rule text. */
  effect: string
}

export type EnergyCardDef = {
  id: string
  set: SetId
  number: string
  name: string
  rarity: CardRarity
  supertype: 'energy'
  types: []
  energyType: string
  /** Which energy type a basic energy provides (undefined for special). */
  provides?: CardType
}

export type CardDef = PokemonCardDef | TrainerCardDef | EnergyCardDef

export type SetData = {
  setId: SetId
  name: string
  releaseDate: string
  cards: CardDef[]
}

export function cardName(card: CardDef): string {
  return card.name
}

export function cardIsPokemon(card: CardDef): card is PokemonCardDef {
  return card.supertype === 'pokemon'
}

export function cardIsTrainer(card: CardDef): card is TrainerCardDef {
  return card.supertype === 'trainer'
}

export function cardIsEnergy(card: CardDef): card is EnergyCardDef {
  return card.supertype === 'energy'
}

export function isBasicPokemon(card: CardDef): boolean {
  return cardIsPokemon(card) && card.stage === 'Basic'
}

/**
 * 04.9 CP4: a Stadium card specifically, not "any Trainer".
 *
 * 076 Xerneas reads "Search your deck for up to 2 **Stadium** cards", so an Item
 * or a Supporter is not a legal pick. `cardIsTrainer` is deliberately NOT enough
 * here: 30C trainer data carries `trainerType` as free text from the upstream API,
 * so the value is trimmed and lower-cased before comparing rather than compared
 * raw — the same defensive read `playTrainer` already uses for its own gate.
 */
export function cardIsStadium(card: CardDef): boolean {
  return cardIsTrainer(card) && card.trainerType.trim().toLowerCase() === 'stadium'
}

/**
 * How many Prize cards the opponent takes when this Pokemon is knocked out.
 *
 * Rulebook: a Pokemon carrying an `EX` rule box is worth **two** Prize cards;
 * an ordinary Pokemon is worth one. Read from the real TCGdex `suffix` field
 * (plan 04.6 CP1), never from the card name, so this is data rather than a
 * proxy — the name already contains "ex", but a name is not a rule box.
 *
 * **The 3-prize Mega ex rule is deliberately absent.** No Mega ex card exists in
 * any set this repo loads (verified: zero, locally and in the TCGdex API), so
 * the branch would be unreachable and untestable, and its upstream `suffix`
 * spelling could not be verified. A hypothetical `"MEGA EX"` therefore returns
 * 1 today, which is the known gap, not a claim about Mega ex. When a Mega set
 * with real card data lands, add it beside the EX branch and a harness case.
 */
export function prizesForKnockOut(card: PokemonCardDef): number {
  return card.suffix?.trim().toUpperCase() === 'EX' ? 2 : 1
}

export function cardRarityRank(rarity: CardRarity): number {
  const order: CardRarity[] = ['common', 'rare', 'pikachu rare', 'double rare', 'illustration rare', 'classic rare', 'special illustration rare', 'futuristic rare']
  return order.indexOf(rarity)
}

export function isUncommonOrBetter(card: CardDef): boolean {
  return cardRarityRank(card.rarity) >= cardRarityRank('rare')
}

export const RARITY_ORDER: CardRarity[] = ['common', 'rare', 'pikachu rare', 'double rare', 'illustration rare', 'classic rare', 'special illustration rare', 'futuristic rare']
