# Architecture Flow — Layers & Data Flow

> Client-side React + Vite app. No backend. All "database" I/O funnels through
> `src/config/index.ts`, which reads/writes the single `flash-games.config`
> document in `localStorage`. Static data (game registry, locale dictionaries)
> is bundled at build time.

## Architecture flowchart

```mermaid
flowchart TD
    main["src/main.tsx"] --> app["src/App.tsx"]
    app --> start["StartPage.tsx — Game Hub"]

    subgraph HUB["Hub screens"]
        start --> credits["CreditsPage.tsx"]
        start --> settingsModal["SettingsModal.tsx"]
        start --> registry["games/index.ts — GameDefinition[]"]
        registry --> bubble["bubble-trouble/BubbleTroubleGame.tsx"]
    end

    subgraph GAME_LOOP["Bubble Trouble runtime"]
        bubble --> canvas["GameCanvas — canvas rAF loop"]
        canvas -->|"onScore / onHealth / onGameOver / onClear"| bubble
        bubble --> hsTable["HighscoreTable.tsx"]
        bubble --> ctrlSettings["ControllerSettings.tsx"]
    end

    subgraph STATE["View state machine"]
        bubble -->|"View union"| views["start / tutorial / loading / playing / paused / remap / gameover / victory / highscore"]
    end

    subgraph PERSIST["Data & persistence layer"]
        cfg["config/index.ts<br/>readConfig / updateConfig / mergeConfig"]
        defaults["config/default.config.json — immutable seed"]
        highscores["bubble-trouble/highscores.ts"]
        l10n["assets/languages/index.ts"]
        defaults --> cfg
        highscores --> cfg
        l10n --> cfg
        settingsModal -->|"volume / locale / keys / music"| cfg
        ctrlSettings -->|"keybindings / primaryKey / mobileControls"| cfg
        bubble -->|"persistLocale()"| l10n
        bubble -->|"saveHighscore()"| highscores
        highscores -->|"readHighscores()"| hsTable
        l10nD["locale JSON files (en / ms / zh)"] --> l10n
        cfg --> ls[("localStorage<br/>flash-games.config")]
    end
```

## Game view state machine (ephemeral runtime flow)

```mermaid
flowchart LR
    START["view: start"] --> TUTORIAL["tutorial"]
    TUTORIAL -->|finish| START
    START -->|"startGame()"| LOADING["loading (650ms)"]
    LOADING --> PLAYING["playing"]
    PLAYING -->|"Escape / pause"| PAUSED["paused"]
    PAUSED -->|"resume"| PLAYING
    PAUSED -->|"mobile calibrate"| REMAP["remap"]
    REMAP -->|"save / exit"| PAUSED
    PLAYING -->|"health <= 0"| GAMEOVER["gameover"]
    PLAYING -->|"all balls cleared"| VICTORY["victory"]
    GAMEOVER -->|"highscores"| HIGHSCORE["highscore"]
    VICTORY -->|"highscores"| HIGHSCORE
    HIGHSCORE -->|"retry"| LOADING
    HIGHSCORE -->|"backToStart"| START
    HIGHSCORE -->|"submitScore() -> saveHighscore()"| START
```

## Persistence call sites

| Caller | Operation | Effect on `flash-games.config` |
|---|---|---|
| `SettingsModal.updateVolume` | `updateConfig(...)` | `settings.volume` |
| `StartPage.changeLocale` | `persistLocale()` → `updateConfig(...)` | `settings.locale` |
| `BubbleTroubleGame.toggleMusic` | `updateConfig(...)` | `settings.music` |
| `ControllerSettings` (remap/reset) | `updateConfig(...)` | `settings.primaryKey`, `settings.keybindings` |
| `BubbleTroubleGame.saveControllerAdjustment` | `updateConfig(...)` | `settings.mobileControls` |
| `highscores.saveHighscore` | `updateConfig(...)` | `highscores['bubble-trouble']` (top-10, desc) |