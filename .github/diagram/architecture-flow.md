# Architecture Flow — Layers & Data Flow

> Client-side React + Vite app. No backend. All "database" I/O funnels through
> `src/config/index.ts`, which reads/writes the single `flash-games.config`
> document in `localStorage`. Static data (game registry, locale dictionaries)
> is bundled at build time.

## Architecture flowchart

```mermaid
flowchart TD
    main["src/main.tsx"] --> app["src/App.tsx"]
    main --> uiSounds["soundEffects.ts — UI & gameplay SFX (reads settings.sfx / muted / sfxVolume; skips silent prefix in pop buffer)"]
    app --> start["StartPage.tsx — Game Hub"]

    subgraph HUB["Hub screens"]
        start --> credits["CreditsPage.tsx"]
        start --> settingsModal["SettingsModal.tsx"]
        start --> registry["games/index.ts — GameDefinition[]"]
        registry --> bubble["bubble-trouble/BubbleTroubleGame.tsx"]
        registry --> tron["tron/TronGame.tsx"]
    end

    subgraph GAME_LOOP["Bubble Trouble runtime"]
        bubble --> canvas["GameCanvas — canvas rAF loop"]
        canvas -->|"onScore / onHealth / onGameOver / onClear"| bubble
        canvas -->|"playBubblePop (pitch ↑ for smaller bubbles)"| uiSounds
        bubble --> hsTable["HighscoreTable.tsx (shared games/highscore)"]
        bubble --> ctrlSettings["ControllerSettings.tsx"]
    end

    subgraph TRON_LOOP["Tron runtime"]
        tron --> tronCanvas["TronGame canvas rAF loop (960x540, 100ms ticks)"]
        tronCanvas -->|"step() / bufferTurn() / continueAfterRound()"| core["tron/game-core.ts — pure grid / round / match logic"]
        core -->|"roundOver overlay (sub-state of playing)"| tron
        tron --> sticks["MobileSticks — two 2D analog sticks (movement = P1, shoot = P2; bot seats hide their stick)"]
        sticks -->|"absolute desired direction (never reverse) -> turnToward()"| core
        tron -->|"start-screen per-seat toggle: Player or Bot (easy / medium / hard)"| bots["tron/bots.ts — TurnSource / BotController / createBot()"]
        bots -->|"decide() per tick -> bufferTurn() before step()"| core
        tron --> tronHs["tron/highscores.ts"]
    end

    subgraph STATE["View state machine"]
        bubble -->|"View union"| views["start / tutorial / loading / playing / paused / remap / gameover / victory / highscore"]
        tron -->|"View union"| tronViews["start / tutorial / loading / playing / paused / gameover / victory / highscore (round-over is an overlay sub-state of playing; stick remap is an in-pause overlay, not a view)"]
    end

    subgraph PERSIST["Data & persistence layer"]
        cfg["config/index.ts<br/>readConfig / updateConfig / mergeConfig"]
        defaults["config/default.config.json — immutable seed"]
        highscores["bubble-trouble/highscores.ts"]
        tronHs["tron/highscores.ts"]
        l10n["assets/languages/index.ts"]
        defaults --> cfg
        highscores --> cfg
        tronHs --> cfg
        l10n --> cfg
        settingsModal -->|"audio (music / sfx / mute) / locale / keys"| cfg
        uiSounds -.->|"readConfig() — settings.sfx / muted / sfxVolume"| cfg
        ctrlSettings -->|"keybindings / primaryKey / mobileControls"| cfg
        bubble -->|"persistLocale()"| l10n
        bubble -->|"saveHighscore()"| highscores
        highscores -->|"readHighscores()"| hsTable
        tron -->|"persistLocale()"| l10n
        tron -->|"recordMatchWin() on match end"| tronHs
        tronHs -->|"readHighscores()"| tron
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

## Tron view state machine (ephemeral runtime flow)

The round-over banner is an **overlay sub-state of `playing`**, not a separate
view; stick remapping happens inside the pause overlay (Save controller /
Exit without saving), also not a separate view.

```mermaid
flowchart LR
    TSTART["view: start"] --> TTUTORIAL["tutorial"]
    TTUTORIAL -->|"finish / skip"| TSTART
    TSTART -->|"startMatch()"| TLOADING["loading (500ms)"]
    TLOADING --> TPLAYING["playing"]
    TPLAYING -->|pause| TPAUSED["paused"]
    TPAUSED -->|resume| TPLAYING
    TPAUSED -->|"forfeit (End match)"| TGAMEOVER["gameover"]
    TPLAYING -->|"round ends (win / tie)"| ROUNDOVER["roundOver overlay — sub-state of playing"]
    ROUNDOVER -->|continue| TPLAYING
    TPLAYING -->|"a player reaches roundsToWin — recordMatchWin(winner) fires once per match"| TVICTORY["victory"]
    TGAMEOVER -->|highscores| THIGHSCORE["highscore — wins per player"]
    TVICTORY -->|highscores| THIGHSCORE
    THIGHSCORE -->|retry| TLOADING
    THIGHSCORE -->|backToStart| TSTART
```

> The Tron highscore view is read-only: the winner's win is recorded
> automatically on entry to `victory` (once per match, under the winner's
> display name set on the start screen). Forfeits, tied rounds, and wins by a
> bot seat record nothing.

## Persistence call sites

| Caller | Operation | Effect on `flash-games.config` |
|---|---|---|
| `SettingsModal.updateAudio` | `updateConfig(...)` | `settings.music`, `settings.musicVolume`, `settings.sfx`, `settings.sfxVolume`, `settings.muted` |
| `StartPage.changeLocale` | `persistLocale()` → `updateConfig(...)` | `settings.locale` |
| `ControllerSettings` (remap/reset) | `updateConfig(...)` | `settings.primaryKey`, `settings.keybindings` |
| `BubbleTroubleGame.saveControllerAdjustment` | `updateConfig(...)` | `settings.mobileControls` |
| `highscores.saveHighscore` | `updateConfig(...)` | `highscores['bubble-trouble']` (top-10, desc) |
| `TronGame.changeLocale` | `persistLocale()` → `updateConfig(...)` | `settings.locale` |
| `TronGame.saveControllerAdjustment` | `updateConfig(...)` | `settings.mobileControls` |
| `tron/highscores.recordMatchWin` (TronGame victory effect) | `updateConfig(...)` | `highscores['tron']` (per-player match-win tally, top-10 by wins) |

### Config change subscriptions

`updateConfig` notifies subscribers registered via `subscribeConfig` (same-call-site table above still applies — subscriptions only read):

| Subscriber | Reaction |
|---|---|
| `start/startPageMusic.ts` (`useStartPageMusic`) | Re-applies `settings.musicVolume` and starts/stops the looping start-page track “Alien no.1” from `settings.music` + `settings.muted`; pauses while a game page is open |