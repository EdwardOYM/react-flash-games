// Fetch + normalize a Pokemon TCG set from the free TCGdex open API into the
// game's CardDef JSON shape (see src/games/pokemon-bnb/cards.ts).
//
// Usage:
//   node scripts/fetch-pokemon-set.mjs <tcgdex-set-id> <out.json> [game-set-id]
//
// Example:
//   node scripts/fetch-pokemon-set.mjs 30th src/assets/pokemon-bnb/sets/30c/cards.json 30c
//
// The 30th Celebration pack's guaranteed Pikachu illustration-rare slot needs a
// stable list of exactly 30 IR Pikachu variations; those carry
// `irVariation: 1..N` in the output (N = however many exist in the set).

const TCGDEX = 'https://api.tcgdex.net/v2/en'

const RARITY_MAP = {
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  'double rare': 'ultraRare',
  'ultra rare': 'ultraRare',
  'secret rare': 'ultraRare',
  'illustration rare': 'illustrationRare',
  'special illustration rare': 'illustrationRare',
  'hyper rare': 'ultraRare',
  // 30th Celebration custom rarities: "Pikachu Rare" is the 30-variation
  // guaranteed illustration-rare slot; "Futuristic Rare" is a chase treatment.
  'pikachu rare': 'illustrationRare',
  'futuristic rare': 'ultraRare',
}

const TYPE_ALIASES = {
  fighting: 'fighting',
  darkness: 'darkness',
  dragon: 'dragon',
  fire: 'fire',
  grass: 'grass',
  lightning: 'lightning',
  metal: 'metal',
  psychic: 'psychic',
  water: 'water',
  fairy: 'psychic',
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

const { mkdir, writeFile } = await import('node:fs/promises')
const { dirname } = await import('node:path')


async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) fail(`${url} -> HTTP ${response.status}`)
  return response.json()
}

function mapCardType(name) {
  return TYPE_ALIASES[String(name).toLowerCase()] ?? 'colorless'
}

function normalizeEnergyCost(cost) {
  if (!Array.isArray(cost)) return []
  return cost.map(mapCardType)
}

function normalizeAttack(attack) {
  return {
    name: String(attack.name ?? ''),
    cost: normalizeEnergyCost(attack.cost),
    damage: Number(attack.damage) || 0,
    text: String(attack.effect ?? '').trim(),
  }
}

function normalizeAbility(ability) {
  return {
    name: String(ability.name ?? ''),
    text: String(ability.effect ?? '').trim(),
    type: String(ability.type ?? 'Ability'),
  }
}

function normalizeWeaknesses(weaknesses) {
  if (!Array.isArray(weaknesses)) return []
  return weaknesses.map((entry) => ({ type: mapCardType(entry.type), value: String(entry.value ?? '') }))
}

function normalizeResistances(resistances) {
  if (!Array.isArray(resistances)) return []
  return resistances.map((entry) => ({ type: mapCardType(entry.type), value: String(entry.value ?? '') }))
}

async function main() {
  const [setId, outPath, gameSetId = setId] = process.argv.slice(2)
  if (!setId || !outPath) fail('usage: node scripts/fetch-pokemon-set.mjs <tcgdex-set-id> <out.json> [game-set-id]')

  const summary = await getJson(`${TCGDEX}/sets/${setId}`)
  console.log(`set: ${summary.name} (${summary.id}, release ${summary.releaseDate})`)

  const list = await getJson(`${TCGDEX}/sets/${setId}`)
  const stubs = list.cards ?? []
  if (stubs.length === 0) fail('set has no cards')

  const cards = []
  const unknownRarities = new Set()
  const fallbacks = []
  let irPikachuIndex = 0

  for (const stub of stubs) {
    const detail = await getJson(`${TCGDEX}/cards/${stub.id}`)
    const rawRarity = String(detail.rarity ?? 'common').toLowerCase()
    const rarity = RARITY_MAP[rawRarity]
    if (!rarity) {
      unknownRarities.add(rawRarity)
      fallbacks.push(`${detail.localId} ${detail.name} (${rawRarity})`)
    }

    const name = String(detail.name ?? '')
    const category = String(detail.category ?? 'pokemon').toLowerCase()
    // Only the set's own "Pikachu Rare" treatment is the guaranteed pack slot's
    // 30-variation pool; ordinary Pikachu illustration rares (e.g. "Pikachu ex"
    // SIRs) are normal chase cards and must NOT take an irVariation number.
    const isGuaranteedPikachuIr = rawRarity === 'pikachu rare'
    const irVariation = isGuaranteedPikachuIr ? ++irPikachuIndex : undefined

    const base = {
      id: `${gameSetId}-${String(detail.localId).padStart(3, '0')}`,
      set: gameSetId,
      number: String(detail.localId),
      name,
      rarity: rarity ?? 'rare',
      supertype: category,
      types: [],
    }

    if (category === 'pokemon') {
      cards.push({
        ...base,
        types: Array.isArray(detail.types) ? detail.types.map(mapCardType) : [],
        hp: Number(detail.hp) || 0,
        stage: String(detail.stage ?? 'Basic'),
        evolvesFrom: detail.evolveFrom ? String(detail.evolveFrom) : undefined,
        retreat: Number(detail.retreat) || 0,
        weaknesses: normalizeWeaknesses(detail.weaknesses),
        resistances: normalizeResistances(detail.resistances),
        attacks: Array.isArray(detail.attacks) ? detail.attacks.map(normalizeAttack) : [],
        abilities: Array.isArray(detail.abilities) ? detail.abilities.map(normalizeAbility) : [],
        irVariation,
        illustrator: detail.illustrator ? String(detail.illustrator) : undefined,
      })
    } else if (category === 'trainer') {
      cards.push({
        ...base,
        trainerType: String(detail.trainerType ?? 'item'),
        effect: String(detail.effect ?? '').trim(),
      })
    } else if (category === 'energy') {
      cards.push({
        ...base,
        energyType: detail.energyType ? String(detail.energyType) : 'normal',
      })
    } else {
      fallbacks.push(`${detail.localId} ${detail.name} (unknown category ${category})`)
      cards.push({ ...base })
    }
  }

  const byRarity = {}
  const bySupertype = {}
  for (const card of cards) {
    byRarity[card.rarity] = (byRarity[card.rarity] ?? 0) + 1
    bySupertype[card.supertype] = (bySupertype[card.supertype] ?? 0) + 1
  }
  const pikachuIrs = cards.filter((card) => card.irVariation !== undefined)

  console.log(`cards: ${cards.length}`)
  console.log('by rarity:', JSON.stringify(byRarity))
  console.log('by supertype:', JSON.stringify(bySupertype))
  console.log(`pikachu illustration rares: ${pikachuIrs.length}`)
  if (unknownRarities.size > 0) console.log(`unmapped rarities (fell back to rare): ${[...unknownRarities].join(', ')}`)
  if (fallbacks.length > 0) console.log(`fallbacks: ${fallbacks.slice(0, 20).join(' | ')}${fallbacks.length > 20 ? ` (+${fallbacks.length - 20} more)` : ''}`)

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify({ setId: gameSetId, name: summary.name, releaseDate: summary.releaseDate, cards }, null, 2)}\n`)
  console.log(`wrote ${outPath}`)
}

main().catch(fail)

