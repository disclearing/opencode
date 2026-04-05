# `run -i` startup performance log

## Benchmark method

- Command:

  ```bash
  script-run run <name> -- time bun run --cwd /home/simon/src/wt/oc-run/packages/opencode --conditions=browser src/index.ts -- run -i -m opencode/gpt-5.4 --thinking "/exit"
  ```

- `real`: shell `time` total runtime
- `first_output`: first delay row from `/tmp/<name>/debug.timing` (proxy for time-to-first-paint)
- `ui_first`: first terminal UI paint timing; when warnings print first, this is cumulative time until the first `158`-byte control-frame row in `debug.timing`

## Baseline (before kept changes)

- Sample run: `perf-check-warning-baseline`
- `real`: `5.495s`
- `first_output`: `5.088s`

## Experiments

### 1) Lazy-load all commands in `src/index.ts`

- Hypothesis: importing only the selected command would shrink startup time.
- Result: broke `run -i` startup with `Provider.defaultLayer` init errors.
- Decision: **discarded**.

### 2) Start split-footer lifecycle in parallel with session/keybind resolution

- Hypothesis: overlap renderer startup with session/config reads.
- Result: regressed (`first_output` moved from ~`4.95s` to ~`5.05s` in repeated runs).
- Decision: **discarded**.

### 3) Lazy-load `./run/tool` from non-interactive output path

- Hypothesis: avoid loading heavy tool formatting code for `run -i` startup.
- Result: no measurable gain (noise-level change only).
- Decision: **discarded**.

### 4) Slim top-level imports in `run.ts` (Provider/Server/Agent/bootstrap)

- Hypothesis: lower run-command parse/import cost before interactive runtime starts.
- Result: no reliable improvement in repeated runs.
- Decision: **discarded**.

### 5) Skip `resolveSessionInfo()` fetch for fresh local interactive sessions

- Hypothesis: avoid unnecessary history fetch on brand-new session boot.
- Result: no measurable improvement in `first_output`.
- Decision: **discarded**.

### 6) Bypass TUI config reads for keybind/diff startup path

- Hypothesis: `TuiConfig.get()` contributes meaningful startup latency.
- Result: regressed/noise; did not improve startup.
- Decision: **discarded**.

### 7) Lazy-load heavy TUI-only command modules from `src/index.ts`

- Hypothesis: `tui/thread` and `tui/attach` imports are expensive and not needed for `run -i`.
- Change:
  - Only import `AttachCommand` when needed (`attach`, top-level help/completion).
  - Only import `TuiThreadCommand` when needed (no explicit command, top-level help/completion).
- Result (kept runs: `perf-exp7-1..3`):
  - `real`: `4.348s` to `4.473s`
  - `first_output`: `3.871s` to `3.990s`
  - medians: `real` `4.432s`, `first_output` `3.954s`
- Side effect: exposed a benign external plugin warning (`Could not find any skills directories...`).
- Decision: **kept**.

### 8) Filter benign `opencode-skills` directory warning during plugin init

- Hypothesis: keep experiment 7 speedup without noisy startup output.
- Change: wrap plugin server init with a `console.warn` filter for the known benign message.
- Result (`perf-exp7c-1..3`):
  - `real`: `4.383s` to `4.444s` (median `4.435s`)
  - `first_output`: `3.979s` to `4.046s` (median `4.028s`)
  - No warning printed before UI startup.
- Decision: **discarded** (user preferred visible warning over suppression).

### 9) Lazy-load non-`run` command modules from `src/index.ts`

- Hypothesis: loading only the invoked command family would reduce pre-runtime startup work.
- Change:
  - Keep `RunCommand` static.
  - Dynamically import `acp`, `mcp`, `debug`, `providers/auth`, `agent`, `upgrade`, `uninstall`, `serve`, `web`, `models`, `stats`, `export`, `import`, `github`, `pr`, `session`, `plugin/plug`, `db`, `generate`, and `attach/thread` based on argv.
- Result (kept runs: `perf-exp9-1..3`):
  - `real`: `4.223s` to `4.267s` (median `4.239s`)
  - `first_output` (warning): `3.743s` to `3.792s` (median `3.768s`)
  - `ui_first`: `3.825s` to `3.867s` (median `3.844s`)
- Decision: **kept**.

### 10) Paint split-footer UI before local session boot completes

- Hypothesis: first paint is blocked on local session boot; painting shell first should improve interactive readiness.
- Change:
  - In `runInteractiveRuntime()`, start local `boot()` in parallel.
  - Create runtime lifecycle/renderer immediately from preview data in `runInteractiveLocalMode()` (`pending` session metadata, first-turn prompt defaults).
  - Resolve boot context afterward for transport/session work and callbacks.
- Result (kept runs: `perf-exp10-1..3`):
  - `real`: `3.890s` to `3.934s` (median `3.911s`)
  - `ui_first`: `2.934s` to `2.993s` (median `2.979s`)
  - Startup warning appears after initial paint instead of blocking paint.
- Decision: **kept**.

### 11) Slim `run.ts` imports aggressively (server/provider/agent/tool/bootstrap)

- Hypothesis: trimming `run.ts` imports would further reduce pre-runtime module load.
- Result: broke command loading with `Provider.defaultLayer`/`Agent` initialization cycle on help/runtime paths.
- Decision: **discarded**.

## Kept delta vs baseline

- Baseline `real`: `5.495s` -> kept median `3.911s` (`-1.584s`, ~`28.8%` faster)
- Baseline `ui_first`: `5.088s` -> kept median `2.979s` (`-2.109s`, ~`41.5%` faster)
