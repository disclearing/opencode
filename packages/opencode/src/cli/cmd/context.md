# Direct Scrollback Context (opencode + opentui)

This document is the orientation doc for the direct/minimal-mode session UI work.

Use this file to answer:

- what the project is trying to build,
- why it exists,
- what the hard constraints are,
- which parts of `opencode` and `opentui` matter,
- what is implemented today versus what is still planned.

Use `direct-render-plan.md` for the detailed v1 session-output spec.
That file is the implementation document. This file is the project/context
document.

## Scope And Related Docs

- Investigation: `/home/simon/src/opendocs/investigations/32-opentui-opencode-direct-render-mode.md`
- Session-output spec: `/home/simon/src/wt/oc-run/packages/opencode/src/cli/cmd/direct-scrollback-plan.md`
- OpenTUI worktree: `/home/simon/src/wt/cli-render-api` (`flicker-less`)
- Opencode worktree: `/home/simon/src/wt/oc-run` (`oc-run`)

## What This Project Is

This project is building a direct interactive mode for `opencode run` that uses a
split-footer terminal layout instead of the fullscreen alternate-screen TUI.

The product shape is:

- immutable session transcript appended to terminal scrollback,
- compact live footer for input and status,
- same session/message/tool model as the fullscreen TUI,
- different rendering strategy because historical terminal output cannot be
  mutated.

This should not be treated as "fullscreen TUI with one renderer flag".

The fullscreen TUI is a fully mutable screen tree. Direct scrollback mode is a
two-lane UI:

- scrollback is the immutable log,
- footer is the mutable control surface.

That distinction is the whole project.

## Why It Exists

The goal is to give `run --interactive` a UI that feels interactive and rich
without taking over the whole terminal.

The desired user experience is:

- prompts and answers read like normal shell history,
- tool activity is visible in scrollback,
- the footer stays available for prompt entry and live state,
- permission and question prompts can be handled in-place without switching to a
  fullscreen app.

## Core Constraints

These constraints should shape all design decisions.

### 1. Scrollback is immutable

Once a row has been committed to terminal scrollback, direct mode cannot go back
and rewrite it.

Implications:

- no in-place transcript mutation,
- no retroactive re-layout of historical assistant output,
- no turning a pending row into a completed row later,
- state changes must become additional commits.

### 2. Footer is the only mutable region

Prompt input, busy state, status, usage, permission UI, and question UI belong in
the footer.

Implications:

- live permission/question interactions stay out of scrollback,
- interrupt and exit affordances stay out of scrollback,
- assistant metadata like duration and usage stay out of scrollback.

### 3. Keep the same product architecture as the fullscreen TUI

The direct mode should still think in terms of:

- session messages,
- message parts,
- tool parts,
- active prompt-area UI.

The fullscreen TUI remains the reference product model. Direct mode is a different
renderer and interaction surface, not a different session model.

### 4. Preserve the OpenTUI ownership boundary

OpenTUI already has a split-footer append pipeline.

The intended boundary is:

- TypeScript creates structured scrollback snapshot commits,
- native split scrollback owns append ordering, settling, and terminal commit.

Direct-mode cleanup should preserve that boundary.

## OpenTUI Pieces This Depends On

The direct-scrollback mode depends on the split-footer renderer path in OpenTUI.

### Public renderer capabilities

`packages/core/src/renderer.ts` exposes the pieces this mode relies on:

- `screenMode: "alternate-screen" | "main-screen" | "split-footer"`
- `footerHeight`
- `externalOutputMode: "capture-stdout" | "passthrough"`
- `consoleMode: "console-overlay" | "disabled"`
- `writeToScrollback(write: ScrollbackWriter)`

Important invariant:

- `writeToScrollback(...)` only works when `screenMode === "split-footer"` and
  `externalOutputMode === "capture-stdout"`.

### Split commit pipeline

The current OpenTUI split path works like this:

1. direct mode calls `renderer.writeToScrollback(...)`,
2. TypeScript renders a snapshot buffer,
3. the snapshot is enqueued in `ExternalOutputQueue`,
4. the render loop flushes that queue through native split-footer commit calls,
5. native `SplitScrollback` owns append progress and final terminal placement.

This is what allows direct mode to append transcript rows while repainting the
footer in the same frame.

### Geometry and lifecycle behavior

Relevant OpenTUI behavior already exists:

- split geometry is centralized in `packages/core/src/lib/render-geometry.ts`,
- pending split output is flushed before resize/suspend/destroy transitions,
- split scrollback append logic lives in
  `packages/core/src/zig/split-scrollback.zig`.

### OpenTUI demos and tests

Useful reference points:

- `packages/core/src/examples/split-mode-demo.ts`
- `packages/core/src/tests/renderer.console-startup.test.ts`

## Opencode Product Shape

Inside opencode, this work is specifically about `run --interactive`.

### Current entrypoint

`packages/opencode/src/cli/cmd/run.ts` adds `--interactive` (`-i`) and routes to
the direct interactive runtime.

Current guardrails:

- incompatible with `--command`,
- incompatible with `--format json`,
- requires TTY stdin/stdout.

### What direct mode should ultimately do

At the product level, direct mode should:

- append user, assistant, reasoning, tool, and error transcript rows to
  scrollback,
- keep the footer live for prompt entry and status,
- use footer-owned permission/question UI,
- stay architecture-compatible with the fullscreen session route.

The exact v1 behavior is specified in `direct-scrollback-plan.md`.

## Current Implementation Status

The current codebase already has a working direct-mode foundation, but it is not
finished v1.

Implemented today:

- split-footer renderer boot and shutdown,
- direct prompt queue and compact footer,
- append-only scrollback commits,
- assistant/reasoning/tool transcript output pipeline,
- basic direct-stream tests.

Not finished yet:

- footer-owned permission UI,
- footer-owned question UI,
- full v1 renderer/test coverage from `direct-scrollback-plan.md`.

Important current-state note:

- the current implementation still auto-rejects permission requests in direct
  mode,
- the plan document intentionally supersedes that behavior for v1,
- `CONTEXT.md` should describe both: current code reality and target direction.

## Related Opencode Files

These are the main direct-mode files.

### Runtime and event flow

- `packages/opencode/src/cli/cmd/run.ts`
- `packages/opencode/src/cli/cmd/run/runtime.ts`
- `packages/opencode/src/cli/cmd/run/stream.ts`
- `packages/opencode/src/cli/cmd/run/session-data.ts`
- `packages/opencode/src/cli/cmd/run/types.ts`

### Footer and direct-mode UI

- `packages/opencode/src/cli/cmd/run/footer.ts`
- `packages/opencode/src/cli/cmd/run/footer.view.tsx`
- future direct footer bodies should live next to these files

### Scrollback formatting

- `packages/opencode/src/cli/cmd/run/scrollback.ts`
- `packages/opencode/src/cli/cmd/run/scrollback-tools.ts`
- `packages/opencode/src/cli/cmd/run/theme.ts`

### Direct-mode tests

- `packages/opencode/test/cli/run/direct-stream.test.ts`

## Fullscreen TUI Files To Mirror

These are the main fullscreen reference files.

- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx`
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`

Why they matter:

- `session/index.tsx` is the reference transcript architecture,
- `permission.tsx` is the reference permission interaction model,
- `question.tsx` is the reference question interaction model,
- `sync.tsx` shows how permission/question/session events are represented in the
  mutable fullscreen store.

## How The Pieces Fit Together

At a high level, the direct-mode flow is:

1. user runs `opencode run --interactive`,
2. `run.ts` creates or resumes a session and calls the direct runtime,
3. `runtime.ts` creates a split-footer renderer and `RunFooter`,
4. prompt submission appends a user row immediately and starts a session prompt,
5. `stream.ts` consumes SDK events and reduces them into scrollback commits plus
   footer state,
6. `footer.ts` writes immutable commits through `renderer.writeToScrollback(...)`,
7. the footer view mutates independently for prompt/status/live interactions,
8. OpenTUI queues the scrollback snapshots and native split scrollback appends
   them.

The detailed session-output contract for that flow now lives in
`direct-scrollback-plan.md`.

## Relationship Between Context And Plan

The two docs serve different purposes.

`context.md` should answer:

- what is this project,
- why is it structured this way,
- which parts of the repo matter,
- what is current reality versus target v1.

`direct-scrollback-plan.md`.
should answer:

- what exact state and types to add,
- how events map to commits and footer view changes,
- how permission/question UI should behave,
- what tests are required,
- what remains on the v1 checklist.

If there is ever a conflict between a high-level statement here and a precise v1
session-output rule, the plan document should win.

## Development

This section is about local development and debugging for the direct-scrollback
work.

### What TUI debugging looks like today

The fullscreen TUI already has a few development/debugging aids, but not a raw
session-event trace.

- local builds write normal opencode logs to `~/.local/share/opencode/log/dev.log`
  unless `--print-logs` is used,
- the fullscreen TUI has a renderer debug overlay toggle,
- the fullscreen TUI has a console overlay toggle,
- `tui/context/sdk.tsx` and `tui/context/sync.tsx` subscribe to and apply SDK
  events, but they do not persist a raw JSON event trace for later inspection.

So the answer is: TUI has logs and overlays today, but not the exact closed-loop
event capture needed for direct-scrollback debugging.

### Direct-mode event trace setup

Direct mode now has a dev-only JSONL trace path.

Enable it with:

- `OPENCODE_DIRECT_TRACE=1`

Default trace files are written under:

- `~/.local/share/opencode/log/direct/`

The filename format is:

- `<timestamp>-<pid>.jsonl`

The most recent traced run is also written to:

- `~/.local/share/opencode/log/direct/latest.json`

That file contains:

- trace file path,
- start time,
- pid,
- cwd,
- argv.

Each line is JSON and captures the closed loop around direct mode, including:

- outbound prompt requests,
- inbound SDK events,
- reducer outputs,
- footer commits,
- footer patches,
- permission replies,
- turn abort/cancel/end markers.

Current record types include:

- `trace.start`
- `recv.subscribe`
- `send.prompt`
- `send.prompt.ok`
- `send.prompt.error`
- `recv.event`
- `reduce.output`
- `ui.commit`
- `ui.patch`
- `send.permission.reply`
- `turn.abort`
- `turn.cancel`
- `turn.end`

This is the intended direct-mode debugging loop: one run, one trace file, exact
request/event/UI history.

### UI helper command

The current helper command for running the direct UI is:

```bash
script-run run dedup -- time bun run --cwd /home/simon/src/wt/oc-run/packages/opencode --conditions=browser src/index.ts -- run -i -m console-zen/gpt-5.4-mini
```

### Recommended direct-trace workflow

Use the UI helper with tracing enabled:

```bash
OPENCODE_DIRECT_TRACE=1 script-run run dedup -- time bun run --cwd /home/simon/src/wt/oc-run/packages/opencode --conditions=browser src/index.ts -- run -i -m console-zen/gpt-5.4-mini
```

After the run, use `latest.json` to find the exact trace file for that run:

```bash
jq . ~/.local/share/opencode/log/direct/latest.json
```

If you are an agent or LLM, this is the file to read first.

### Pretty-printing the trace

Pretty-print the latest traced run:

```bash
jq . "$(jq -r .path ~/.local/share/opencode/log/direct/latest.json)"
```

Show only time and record type for the latest traced run:

```bash
jq -r '[.time, .type] | @tsv' "$(jq -r .path ~/.local/share/opencode/log/direct/latest.json)"
```

### How to use the trace file

For direct-scrollback work, the trace file should answer three questions:

- what request did the client send,
- what exact events came back from the SDK stream,
- what commits and footer patches did direct mode derive from them.

That is the closed loop you want when debugging stream ordering, permission
behavior, question behavior, or footer/transcript mismatches.

## Practical Local Workflow

- Run opencode in direct interactive mode:

```bash
bun run --cwd /home/simon/src/wt/oc-run/packages/opencode --conditions=browser src/index.ts -- run -i -m opencode/mimo-v2-omni-free "hello world?"
```

- Link opencode to the local OpenTUI worktree:

```bash
build-opencode-local --opentui /home/simon/src/wt/cli-render-api --opencode /home/simon/src/wt/oc-run
```

- Note: linking is already done in this setup; rerun only after local OpenTUI
  changes.

## Working Rules For Cleanup

- preserve the append-only scrollback vs mutable-footer split,
- preserve the OpenTUI TS-vs-native ownership boundary,
- mirror fullscreen session architecture instead of inventing a new product
  model,
- keep `context.md` high-level and keep detailed behavior in
  `direct-render-plan.md`,
