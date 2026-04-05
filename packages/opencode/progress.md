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

### 12) Defer `Server` import in `run.ts` to request-time fetch wrappers

- Hypothesis: static `run.ts` import of `server/server` still adds pre-paint module cost; deferring it to local fetch wrappers should improve UI paint.
- Change:
  - Remove top-level `Server` import from `run.ts`.
  - Dynamically import `Server` inside both local fetch wrappers used by interactive-local and bootstrap execution paths.
- Result (kept runs: `perf-exp12-1..3`):
  - `real`: `3.887s` to `3.908s` (median `3.893s`)
  - `ui_first`: `2.830s` to `2.861s` (median `2.843s`)
- Decision: **kept**.

### 13) Defer `Agent` import in `run.ts` for local-agent resolution

- Hypothesis: removing top-level `Agent` import should shave additional startup time when `--agent` is not used.
- Result (`perf-exp13-1..3`): noisy and slightly worse median `ui_first` than experiment 12.
- Decision: **discarded**.

### 14) Defer `bootstrap` import in `run.ts`

- Hypothesis: `bootstrap` and transitive project/runtime imports are unnecessary for local interactive mode and can be deferred.
- Result: broke startup with initialization-cycle errors (`Config.defaultLayer` / `Provider.defaultLayer` / `Instance` reference errors).
- Decision: **discarded**.

### 15) Merge footer keybind/diff config reads

- Hypothesis: replacing two `TuiConfig.get()` calls with one combined read would reduce startup work.
- Result (`perf-exp19-1..3`): no gain; slightly worse `ui_first` (about `2.89s` median in that revision).
- Decision: **discarded**.

### 16) Defer model parsing and provider import into local runtime boot

- Hypothesis: parsing `--model` early in `run.ts` adds avoidable pre-paint module load.
- Result (`perf-exp20-1..3`): no reliable `ui_first` improvement.
- Decision: **discarded**.

### 17) Disable Kitty keyboard setup for split-footer runtime

- Hypothesis: disabling Kitty keyboard protocol setup may reduce terminal startup handshakes.
- Result (`perf-exp21-1..3`): no consistent gain and worse tail latency.
- Decision: **discarded**.

### 18) Defer `RunFooter` module import until after first splash render

- Hypothesis: static loading of `footer.ts`/`footer.view.tsx` dominates pre-paint startup.
- Change:
  - In `runtime.lifecycle.ts`, stop static-importing `RunFooter`.
  - Queue entry splash, await first renderer idle, then dynamically import `./footer` and construct `RunFooter`.
  - Widen `Lifecycle.footer` type to `FooterApi`.
- Result (`perf-exp25-1..3`):
  - `real`: `3.267s` to `3.438s` (median `3.317s`)
  - `ui_first`: `2.275s` to `2.431s` (median `2.293s`)
- Decision: **kept**.

### 19) Defer run-runtime imports from `run.ts` and preload with a promise

- Hypothesis: avoid static `run/runtime` module load cost while still warming it before interactive handlers need it.
- Change:
  - Replace static runtime import with `const runtimeTask = import("./run/runtime")`.
  - Await `runtimeTask` only in interactive branches.
  - Switch model parsing to a lightweight local splitter equivalent to `Provider.parseModel` behavior.
  - Defer agent module import to `localAgent()` when `--agent` is present.
- Result (`perf-exp35-1..3`):
  - `real`: `3.235s` to `3.284s` (median `3.270s`)
  - `ui_first`: `2.234s` to `2.299s` (median `2.271s`)
- Decision: **kept**.

### 20) Lazy-load non-interactive tool formatting and stream modules

- Hypothesis: `run/tool`, `stream.transport`, and `runtime.queue` are not needed for first paint in interactive mode.
- Change:
  - Make `tool(part)` async and dynamically import `./run/tool` only when non-interactive tool output is rendered.
  - In `runtime.ts`, dynamically import `./stream.transport` and `./runtime.queue` at execution time.
- Result: slight/noise-level gain by itself; kept as part of the final import-deferral set.
- Decision: **kept**.

### 21) Preload `bootstrap` via dynamic import promise

- Hypothesis: replace static `bootstrap` import with `const bootstrapTask = import("../bootstrap")` to keep ordering but remove blocking static load.
- Result: still broke startup with config/instance initialization cycles (`Config.defaultLayer`, `Config.Keybinds`, `Log.create` undefined errors).
- Decision: **discarded**.

## Kept delta vs baseline

- Baseline `real`: `5.495s` -> kept median `3.270s` (`-2.225s`, ~`40.5%` faster)
- Baseline `ui_first`: `5.088s` -> kept median `2.271s` (`-2.817s`, ~`55.4%` faster)
