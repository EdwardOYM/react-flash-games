# Database Schema — Persisted Document Model

> **Note:** `react-flash-games` is a client-side React + Vite app with **no database engine**.
> The entire persisted data model is a single JSON document stored in `localStorage`
> under the key `flash-games.config`, seeded by the immutable bundled default
> (`src/config/default.config.json`) and accessed through `src/config/index.ts`.
> The ER diagram below is a **document-model mapping**, not relational SQL.

## Persisted schema (`AppConfig`)

```
AppConfig
├── version: number                                        (schema version, currently 1)
├── settings
│   ├── musicVolume: number                                (0–100, default 70)
│   ├── sfx: boolean                                       (default true)
│   ├── sfxVolume: number                                  (0–100, default 70)
│   ├── muted: boolean                                     (default false)
│   ├── locale: 'en' | 'ms' | 'zh'
│   ├── music: boolean
│   ├── primaryKey: string                                 (default "Space")
│   ├── keybindings: Record<string, string>                (e.g. bubble-shoot → ArrowUp, tron-p1-up → w, pokemon-confirm → Enter)
│   └── mobileControls
│       ├── movement: { x, y, scale }                      (percent pos + 0.5–2.5 scale)
│       └── shoot: { x, y, scale }
├── highscores: Record<gameId, { name, score }[]>          (top-10, sorted desc; tron + pokemon-bnb score = lifetime match wins per player name)
└── openedCards: Record<playerName, string[]>              (04.3; key = lowercased trimmed player name → that player's sorted,
                                                            deduplicated opened card ids; default seed {}. Written only by
                                                            pokemon-pack-battle: the ceremony records the local seat's own packs,
                                                            the solo RIP page records each rip)
```

## ER diagram

```mermaid
erDiagram
    APPCONFIG ||--|| SETTINGS : "1-to-1"
    APPCONFIG ||--o| MOBILE_CONTROLS : "1-to-1 (nested)"
    APPCONFIG ||--o| HIGHSCORE_BUCKETS : "1-to-many (keyed by gameId)"
    APPCONFIG ||--o| OPENED_CARDS : "04.3, 1-to-many (keyed by player name)"
    APPCONFIG {
        number version PK "schema version = 1"
        string storageKey "localStorage['flash-games.config']"
    }

    SETTINGS ||--|| KEY_REBINDINGS : "1-to-1 (map)"
    SETTINGS {
        number musicVolume "0-100, default 70"
        boolean sfx "default true"
        number sfxVolume "0-100, default 70"
        boolean muted "default false"
        string locale "en | ms | zh"
        boolean music "default true"
        string primaryKey "default: Space"
    }

    KEY_REBINDINGS {
        map bindings "bindingId -> key string"
    }

    MOBILE_CONTROLS ||--|| MOVEMENT_STICK : "movement"
    MOBILE_CONTROLS ||--|| SHOOT_BUTTON : "shoot"
    MOVEMENT_STICK {
        number x "percent 0-100, default 12"
        number y "percent 0-100, default 72"
        number scale "0.5-2.5, default 1"
    }
    SHOOT_BUTTON {
        number x "percent 0-100, default 88"
        number y "percent 0-100, default 72"
        number scale "0.5-2.5, default 1"
    }

    GAME_CATALOG {
        string id PK "currently: bubble-trouble, tron, pokemon-bnb, pokemon-pack-battle"
        string titleKey "games.bubbleTrouble, games.tron, games.pokemonBnbMini, games.pokemonPackBattle"
        string statusKey "ready | comingSoon"
    }
    GAME_CATALOG ||--o| HIGHSCORE_BUCKETS : "game.id = bucket key"

    HIGHSCORE_BUCKETS {
        string gameId PK "e.g. bubble-trouble, tron, pokemon-bnb, pokemon-pack-battle"
    }
    HIGHSCORE_BUCKETS ||--o{ HIGHSCORE_ENTRY : "holds top-10"
    HIGHSCORE_ENTRY {
        int rank "implicit 1-10 (insertion order)"
        string name "player name"
        number score "sorted descending; tron / pokemon-bnb / pokemon-pack-battle: lifetime match wins per player name (aggregated)"
    }

    OPENED_CARDS {
        string playerName PK "lowercased trimmed display name, e.g. ash"
    }
    OPENED_CARDS ||--o{ OPENED_CARD_ID : "sorted unique ids"
    OPENED_CARD_ID {
        string cardId "set card id (e.g. 30c-042) or the rip's synthetic energy id (e.g. 30c-energy-fire)"
    }

    LOCALE_DICTIONARY ||..|| APPCONFIG : "settings.locale indexes"
    LOCALE_DICTIONARY {
        string code PK "en | ms | zh"
        map translations "TranslationKey -> localized string"
    }
```

> `GAME_CATALOG` and `LOCALE_DICTIONARY` are static/read-only source data (TS modules + JSON), not rows in storage — the dashed line signals that they conceptually "reference" the persisted document but live outside it.
>
> **04.2 ceremony state is session-only:** the per-pack `opened`, six-card `revealed`, and `expanded` flags live in the Pack Battle runtime and are replayed through protocol v3 `ceremony-sync`; they are not `AppConfig` fields and are not written to `localStorage`. The existing persisted `openedCards` collection bucket is unchanged.

## Source references

| Layer | Location | Role |
|---|---|---|
| **Schema seed** | `src/config/default.config.json` | Immutable defaults (`version`, `settings`, `highscores`, `openedCards`) |
| **Persistence API** | `src/config/index.ts` | `readConfig()` / `writeConfig()` / `updateConfig()` + `mergeConfig()` deep-merge over defaults (`settings`, `highscores`, `openedCards`) |
| **Persisted document** | `localStorage['flash-games.config']` | Single `AppConfig` record: settings + per-game highscores + the opened-card collection |
| **Collection bucket (04.3)** | `pokemon-pack-battle/collection.ts` | `recordOpenedCards()` / `readOpenedCards()` / `listPlayers()` / `hasCard()` over `openedCards`; only the local seat's own packs are ever written (ceremony: `cardIdsForSeat`, host = even packs / guest = odd packs; rip page: the solo open) |
| **Static data** | `games/index.ts`, `assets/languages/*.json` | Game registry (read-only), en/ms/zh translation dictionaries |
| **Ephemeral state** | `BubbleTroubleGame.tsx`, `tron/TronGame.tsx`, `pokemon-bnb/PokemonBnbGame.tsx`, `pokemon-pack-battle/PokemonPackBattleGame.tsx` | Per-session runtimes + view state machines (never persisted); Tron adds session-only match options (rounds-to-win 1-9, per-player colors, per-player display names); Pokemon adds session-only lobby settings (set 30C, packs 1-6, prize cards 2-6, timer off/45/60/90s) that deliberately stay out of `AppConfig`; Pack Battle adds session-only lobby settings (set 30C, packs per player 1-18), per-pack ceremony flags (`opened`, six `revealed` flags, `expanded`), and focused-seat state for free-order opening, all replayed over protocol v3 but never stored in `AppConfig`; the 04.3 `rip` / `unlocked` views keep their solo seed session-only while the pulled card ids go to the persisted `openedCards` bucket |