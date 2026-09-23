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

export function cardRarityRank(rarity: CardRarity): number {
  const order: CardRarity[] = ['common', 'rare', 'double rare', 'illustration rare', 'pikachu rare', 'special illustration rare', 'futuristic rare']
  return order.indexOf(rarity)
}

export function isUncommonOrBetter(card: CardDef): boolean {
  return cardRarityRank(card.rarity) >= cardRarityRank('rare')
}

export const RARITY_ORDER: CardRarity[] = ['common', 'rare', 'double rare', 'illustration rare', 'pikachu rare', 'special illustration rare', 'futuristic rare']
