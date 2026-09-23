# Pokemon TCG B&B Mini — Set Data

Static, build-time card data for the Pokemon B&B mini game (`src/games/pokemon-bnb/`).
Card data is bundled (no runtime API calls for data); card artwork is hotlinked at
runtime from TCGdex's hosted CDN (see Credits below) and falls back to a data-free
type tint of the same size when unreachable.

## Layout

```
sets/<set-id>/
  cards.json   # every card in the set, normalized CardDef JSON (see cards.ts)
  pack.json    # pack slot configuration + pull-rate weights for that set

card-back.jpg  # bundled face-down card back (CP10) - the only raster asset in this folder
```

Current sets:

| Set id | Name | Cards | Source |
|---|---|---|---|
| `30c` | 30th Celebration (2026-09-16, official abbreviation "30C") | 158 + 30 Classic Collection variants | TCGdex open API |

## Adding a future set

1. Run the generator (needs Node 18+, free public TCGdex API):

   ```
   node scripts/fetch-pokemon-set.mjs <tcgdex-set-id> src/assets/pokemon-bnb/sets/<set-id>/cards.json
   ```

2. Review the generated `cards.json` (the script prints a rarity/supertype summary and any
   unmapped rarities/shapes it had to fall back on).
3. Hand-write `pack.json` for the set (slots follow the physical pack configuration; weights
   documented below).
4. Register the set in `src/games/pokemon-bnb/cards.ts` (one import + one registry line).

## Data normalization notes

- Source fields come from TCGdex card details (rarity, category, types, hp, stage, evolveFrom,
  weaknesses/resistances, retreat, attacks, abilities). The generator maps them into the game's
  `CardDef` shape; raw attack/ability/trainer text is kept verbatim in `text` fields as engine
  data for the effect mapping below — it is never rendered on a card face, which shows the
  hosted artwork instead.
- Rarity buckets (game-side): `common`, `uncommon`, `rare`, `ultraRare` (ex / double rare /
  ultra / secret), `illustrationRare` (illustration / special illustration / hyper rare).
- 30 Pikachu illustration-rare variations are tagged `irVariation: 1..30` (the pack's guaranteed
  Pikachu slot picks uniformly from these).
- `effectId` (mapping card text to the battle engine's effect scripts) is NOT part of the
  generated data; the engine (CP7) keeps a curated card-id → effect mapping with a
  damage-only fallback for unmapped text.

## Pack configuration (30C)

Physical-style pack: 5 cards — 2× common, 1× uncommon-or-better (weighted up to hits),
1× guaranteed Pikachu illustration rare (1 of 30), 1× basic energy.
Slot weights in `pack.json` are configurable estimates calibrated to community pull-rate
reporting (DigitalTQ 30th Celebration pull rates); tweak them there without touching code.

## Credits / sources

- Card data: [TCGdex](https://tcgdex.dev) open API (free, no key).
- Card artwork: hotlinked at runtime from TCGdex's hosted image CDN
  (`https://assets.tcgdex.net/en/me/30th/<number>/low.png`, see
  `src/games/pokemon-bnb/cardImage.ts`). Nothing is downloaded or stored in the
  repo (user decision, CP11) - with exactly one exception, the bundled card back below.
  The hosted artwork IS the card face (CP11-E): no
  `cards.json` text is rendered on any face, and the card box is one uniform
  fixed size in every view. A failed load (e.g. offline), or a card with no
  hosted art (the synthetic basic energies), falls back to a data-free type
  tint of that same size.
- Card back (bundled, CP10): `card-back.jpg` is a locally bundled fan-made Pokemon TCG card back.
  The source PNG was 828x1147 / 1,445,618 B with genuinely transparent rounded corners; the shipped
  file is **480x665, JPEG q90, 79,029 B** (95% smaller, and >=2x the widest rendered card at 245 px
  CSS). PNG was rejected for size (573 KB at 480x665) and no WebP encoder exists on the build
  machine. The transparent corners are matted to the artwork's own border colour `#192653`, because
  the card frame's 10 px `border-radius` clip is *wider* than the art's rounded silhouette, so those
  corner pixels stay visible and must carry the border colour. A failed load falls back to the CSS
  gradient back it replaced (see `PokemonCard.tsx`).
- Card back credit: **AtomicmonkeyTCG** (watermark "AtomicmonkeyTCG.deviantart.com" on the artwork;
  fan-made, non-commercial fair use). Mirrored on the credits page as the `cardBack` /
  `cardBackCredit` row (CP10-E).
- Pull-rate reference: DigitalTQ "Pokemon TCG 30th Celebration Pull Rates".
- Gameplay rules: Pokemon TCG rulebook (`par_rulebook_en.pdf`, pokemon.com).
- Pokemon and Pokemon TCG are trademarks of Nintendo / Creatures Inc. / GAME
  FREAK inc.; card images and artwork are © their rights holders and the listed
  illustrators. This fan project is non-commercial and uses the hosted artwork
  under the fair-use concept.

### Removing the hosted artwork (one commit)

If the hotlinking is ever challenged, the artwork strips cleanly:

1. Delete `src/games/pokemon-bnb/cardImage.ts`.
2. Remove the `CardArt` component + `cardImageUrl` import + art render line from
   `src/games/pokemon-bnb/PokemonCard.tsx` (the art rules in `PokemonCard.css`
   and the `isolation: isolate` on `.pkm-card` can stay or go; keep `tintClass`,
   which becomes the visible face).
3. Drop the "Card artwork" credit row from `src/credits/CreditsPage.tsx` and the
   `artwork`/`artworkCredit` keys from the three language dictionaries.

The game reverts to fully offline data-free faces (uniform-size type tints) with
no other changes. The bundled card back is separate (see below) and keeps working
either way.

### Removing the bundled card back (one commit)

The card back is the only file in this folder that is not set data:

1. Delete `src/assets/pokemon-bnb/card-back.jpg`.
2. Remove the `cardBackImage` import, the exported `cardBackUrl` and the pure
   `cardBackShowsArt` rule from `src/games/pokemon-bnb/cardImage.ts`.
3. Remove the back-image branch from `src/games/pokemon-bnb/PokemonCard.tsx` and the
   `.pkm-card-back-art` rule (plus its comment) from `PokemonCard.css`.
4. Drop the `cardBack` / `cardBackCredit` row from `src/credits/CreditsPage.tsx`, the
   same two keys from `en.json` / `ms.json` / `zh.json`, and both names from the
   `TranslationKey` union in `src/assets/languages/index.ts`.

Every face-down card reverts to the CSS gradient back with the gold ⬢ mark
(`.pkm-card-back`), which is exactly the failed-load fallback players already see,
so no play path changes.
