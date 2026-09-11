# Terminal Commands — Non-Interactive PowerShell Rules

This workspace runs `run_commands` through Windows PowerShell. Commands that open an interactive pager or prompt will hang at `(END)` and never exit. Follow these rules for every terminal call.

## Why terminals get stuck at `(END)`

- `git` opens the `less` pager for output like `git log`, `git diff`, `git show`, `git branch`, and sometimes `git status`.
- `less` / `more` / `vim` / `nano` wait for keyboard input (`q` to quit), which the tool cannot send.
- Long-running or prompting commands (`vite`, `npm run dev`, `code --wait`, `pause`, `Read-Host`) never return.

## Mandatory rules

1. **Never use a pager.**
   - Prefix every git command with `git --no-pager`, e.g. `git --no-pager status --short`, `git --no-pager diff --stat`, `git --no-pager log --oneline -5`.
   - Never run bare `git log`, `git diff`, `git show`, or `git branch` without `--no-pager`.
   - Never run `less`, `more`, `vim`, `nano`, `pause`, or `Read-Host`.
2. **Use PowerShell-native cmdlets, not CMD aliases.**
   - Use `Get-ChildItem -Force`, `Get-Content`, `Select-String -Path` instead of `dir /B`, `type`, `findstr`.
   - `dir /B` fails in PowerShell with `Cannot find path 'C:\B'` — do not use it.
3. **Keep commands non-interactive and bounded.**
   - Add non-interactive flags where available: `npm --no-update-notifier`, git `--no-pager --non-interactive`, PowerShell `-ErrorAction SilentlyContinue` for optional paths.
   - Never start dev servers (`npm run dev`, `vite`, `vite --host`, `npm run preview`) via `run_commands`; use `npm run build` for validation.
   - Keep each command under ~12000 characters; split independent work into separate entries in the same `commands` array.
4. **Prefer dedicated tools over shell output.**
   - Prefer `read_files` over `Get-Content`/`type` for file content.
   - Prefer `search_codebase` over `Select-String`/`findstr` for code search.
   - Reserve `run_commands` for builds, git status, directory listings, and validation.
5. **Always prove the command exited.**
   - End inspection sequences with a sentinel such as `Write-Output '---done---'` so a missing sentinel signals a hang.
   - Example safe sequence: `git --no-pager status --short; Write-Output '---done---'`.
   - If output is long, page it yourself with `| Select-Object -First 50` or `Get-Content -TotalCount 50`, never with an interactive pager.

## Safe examples

```powershell
git --no-pager status --short
git --no-pager diff --stat; Write-Output '---done---'
Get-ChildItem -Force | Format-Table Name, Mode
Get-Content package.json -TotalCount 30; Write-Output '---done---'
Select-String -Path 'src/start/StartPage.css' -Pattern 'game-row' | Select-Object -First 10
npm run build
```

## Unsafe examples (do not use)

```powershell
git log                 # pager, hangs at (END)
git diff                # pager, hangs at (END)
dir /B                  # CMD syntax, fails in PowerShell
type package.json       # use Get-Content instead
less src/start/StartPage.css   # interactive, never exits
npm run dev             # long-running server, never exits
```
