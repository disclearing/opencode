# KISS Guide For Direct Mode

The branch got hard to reason about because direct mode stopped being a thin
split-footer renderer and turned into a second session app. The biggest cleanup
win is to keep only the direct-specific shell and delete duplicate session
state, duplicate UI behavior, and duplicate formatting policy.

## Current Flow

```text
prompt typed in footer
  -> packages/opencode/src/cli/cmd/run/footer.view.tsx
     RunFooterView.onSubmit()
  -> packages/opencode/src/cli/cmd/run/footer.ts
     RunFooter.handlePrompt()
  -> packages/opencode/src/cli/cmd/run/runtime.ts
     runPromptQueue.push() / pump()
     - appends the user row locally
     - calls runPromptTurn(...)
  -> packages/opencode/src/cli/cmd/run/stream.ts
     runPromptTurn()
     - opens sdk.event.subscribe(...)
     - sends sdk.session.prompt(...)
  -> server / SDK stream
  -> packages/opencode/src/cli/cmd/run/stream.ts
     reduceSessionData(event)
     -> commits[] ------------------------------+
     -> footer.patch / footer.view -----------+ |
                                              | |
scrollback lane                               | |
  -> packages/opencode/src/cli/cmd/run/footer.ts
     RunFooter.append() / flush()
  -> packages/opencode/src/cli/cmd/run/scrollback.tsx
     entryWriter() / normalizeEntry()
  -> @opentui/core
     renderer.writeToScrollback(ScrollbackWriter)
  -> ScrollbackWriter -> ScrollbackSnapshot -> split screenbuffer/native append
  -> terminal scrollback

footer lane
  -> packages/opencode/src/cli/cmd/run/footer.ts
     patch() / present()
  -> packages/opencode/src/cli/cmd/run/footer.view.tsx
     RunFooterView
  -> packages/opencode/src/cli/cmd/run/footer.permission.tsx
     RunPermissionBody
  -> packages/opencode/src/cli/cmd/run/footer.question.tsx
     RunQuestionBody
  -> live footer buffer
```

## File Map

| Stage                    | Files                                                                                                                                                                                                                  | Code                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CLI entry + session boot | `packages/opencode/src/cli/cmd/run.ts`, `packages/opencode/src/cli/cmd/run/runtime.ts`                                                                                                                                 | `RunCommand.handler`, `runInteractiveMode()`, `runInteractiveLocalMode()` |
| Prompt submit            | `packages/opencode/src/cli/cmd/run/footer.view.tsx`, `packages/opencode/src/cli/cmd/run/footer.ts`, `packages/opencode/src/cli/cmd/run/runtime.ts`                                                                     | `onSubmit()`, `handlePrompt()`, `runPromptQueue()`                        |
| Request + event stream   | `packages/opencode/src/cli/cmd/run/stream.ts`                                                                                                                                                                          | `runPromptTurn()`, `sdk.session.prompt()`, `sdk.event.subscribe()`        |
| Event reduction          | `packages/opencode/src/cli/cmd/run/stream.ts`                                                                                                                                                                          | `reduceSessionData()`                                                     |
| Scrollback rendering     | `packages/opencode/src/cli/cmd/run/footer.ts`, `packages/opencode/src/cli/cmd/run/scrollback.tsx`                                                                                                                      | `append()`, `flush()`, `entryWriter()`                                    |
| Footer rendering         | `packages/opencode/src/cli/cmd/run/footer.ts`, `packages/opencode/src/cli/cmd/run/footer.view.tsx`, `packages/opencode/src/cli/cmd/run/footer.permission.tsx`, `packages/opencode/src/cli/cmd/run/footer.question.tsx` | `patch()`, `present()`, `RunFooterView`                                   |

## What Direct Mode Should Own

- split-footer renderer setup and shutdown
- immediate local append of the user prompt
- append-only projection of assistant, reasoning, and tool events into
  scrollback commits
- footer-only prompt, permission, and question surface

## What Direct Mode Should Not Own

- a second canonical session store or reducer if the fullscreen stack already
  models the same message, part, permission, and question data
- a second copy of permission or question behavior
- a second copy of prompt history, keybind, or variant persistence logic
- presentation rules encoded as fake transcript strings
- more than one interactive runtime path

That does not mean direct mode cannot reduce or project events at all.

- direct mode still needs a small output projector for append-only concerns like
  sent text, started or finished tool rows, and the active footer view
- it should not keep a second full copy of session truth when fullscreen already
  has that model

## Non-Regression Guardrails

These simplifications are about removing indirection, not cutting product
abilities from `direct-render-plan.md`.

- keep the append-only scrollback vs mutable footer split
- keep immediate local user-row append on submit, and keep synced user events
  from duplicating that row
- keep assistant and reasoning streaming behavior: buffering until kind is known,
  ordered progress flushes, interrupt markers, reasoning suppression when
  thinking is off, and bash echo de-dupe scoped to the first assistant flush
- keep tool lifecycle behavior: stable `start`, `progress`, `final`, and error
  ordering with no duplicate rows
- keep stable snapshot rendering for completed tool payloads; simplification must
  not flatten `write`, `edit`, `apply_patch`, `task`, `todowrite`, and
  `question` back to generic text-only output
- keep tool-name renderer mapping and generic fallback so no supported tool loses
  output
- keep assistant metadata, usage, and duration in the footer only, not as new
  transcript rows
- keep footer-owned permission UI with the same stages and actions from the
  plan; simplification must not regress back to auto-reject or transcript-owned
  permission prompts
- keep footer-owned question UI with the same reply, reject, custom-answer, and
  multi-question behavior from the plan
- keep deterministic footer view precedence: `permission > question > prompt`
- keep prompt draft preservation across non-prompt views
- keep non-prompt keyboard ownership and keep `ctrl+c` global
- keep the newline and first-part gap behavior required by split scrollback
- keep `permission.asked` and `question.asked` out of scrollback
- keep the required reducer, footer, snapshot, and newline tests from the plan
  even if the current branch temporarily deleted them

When a fix item says to deduplicate with fullscreen, read that as preserving one
behavior model or shared pure helpers where useful. Do not read it as permission
to drop direct-mode footer bodies, drop snapshot builders, or force shared
fullscreen/direct components right now.

## Fix List

### Core Architecture

- 2. Stop treating direct mode as a second session app.
     Files: `packages/opencode/src/cli/cmd/run/runtime.ts`, `packages/opencode/src/cli/cmd/run/stream.ts`, `packages/opencode/src/cli/cmd/run/footer.view.tsx`, `packages/opencode/src/cli/cmd/run/footer.permission.tsx`, `packages/opencode/src/cli/cmd/run/footer.question.tsx`
     Why: the branch now reimplements prompt UI, permission UI, question UI,
     reducer/store, variant state, history, and keybind behavior.
     Target: keep only the direct-specific shell and project the existing session
     model into two lanes: scrollback and footer.

- 4. Remove the extra protocol translation layer if possible.
     Files: `packages/opencode/src/cli/cmd/run/types.ts`, `packages/opencode/src/cli/cmd/run/stream.ts`, `packages/opencode/src/cli/cmd/run/scrollback.tsx`
     Why: the current flow is
     `SDK event -> SessionData -> StreamCommit -> normalized string -> ScrollbackWriter`.
     Target: render from typed message, part, and tool state, or keep only a very
     small typed append-event model with no string parsing.

- 5. Delete sentinel transcript strings.
     Files: `packages/opencode/src/cli/cmd/run/stream.ts`, `packages/opencode/src/cli/cmd/run/scrollback.tsx`
     Why: `[tool:...:end]`, `[tool:...:error]`, `[assistant:interrupted]`, and
     `[reasoning:interrupted]` are synthetic control messages that later get decoded
     by the renderer.
     Target: use typed fields for tool lifecycle and interruption state.

- 6. Delete layout sentinels from transcript data.
     Files: `packages/opencode/src/cli/cmd/run/footer.ts`, `packages/opencode/src/cli/cmd/run/scrollback.tsx`, `packages/opencode/src/cli/cmd/run/types.ts`
     Why: `gap: true` and empty commits are layout hacks, not transcript data.
     Target: keep spacing and newline behavior inside the renderer or writer layer,
     not in the transcript model.

- 7. Put one module in charge of footer state.
     Files: `packages/opencode/src/cli/cmd/run/runtime.ts`, `packages/opencode/src/cli/cmd/run/stream.ts`, `packages/opencode/src/cli/cmd/run/footer.ts`
     Why: queue, phase, duration, status, interrupt, exit, and active view are
     mutated from several places.
     Target: one footer controller owns state transitions; everyone else emits simple
     events into it.

- 15. Fix the dependency direction between modules.
      Files: `packages/opencode/src/cli/cmd/run/scrollback.tsx`, `packages/opencode/src/cli/cmd/run/stream.ts`, `packages/opencode/src/cli/cmd/run/footer.permission.tsx`
      Why: `scrollback.tsx` imports `toolView()` from `stream.ts`, and
      `footer.permission.tsx` imports `toolDiffView()` and `toolFiletype()` from
      `scrollback.tsx`.
      Target: move shared pure helpers to a neutral module and keep the flow
      one-directional.

### Runtime And Event Flow

- 1. Collapse interactive boot into one path.
     Files: `packages/opencode/src/cli/cmd/run/runtime.ts`
     Why: `runInteractiveBootMode()` and `runInteractiveMode()` both create the
     renderer, footer, signal handling, splash, prompt queue, and teardown.
     Target: keep one runtime and pass a small `boot()` callback that resolves
     `{ sdk, sessionID, sessionTitle, agent, model, variant }`.

- 3. Remove per-turn event subscriptions.
     Files: `packages/opencode/src/cli/cmd/run/stream.ts`
     Why: `runPromptTurn()` opens `sdk.event.subscribe()` for every prompt. That adds
     extra abort, close, and reply plumbing and makes session state turn-local.
     Target: one session-level subscription for the whole interactive run.

- 16. Reduce `stream.ts` to one job.
      Files: `packages/opencode/src/cli/cmd/run/stream.ts`
      Why: this file currently mixes network orchestration, subscription lifecycle,
      reducer logic, footer-view selection, permission and question reply wiring, echo
      stripping, and tool render policy.
      Target: split into `session event store or projector` and
      `prompt turn transport`.

- 17. Reduce `runtime.ts` to one job.
      Files: `packages/opencode/src/cli/cmd/run/runtime.ts`
      Why: this file currently owns renderer lifecycle, splash, prompt queue, session
      loading, history loading, keybind loading, model info loading, variant
      persistence, SIGINT, and local-vs-remote boot.
      Target: split into `boot or session lookup`, `renderer or footer lifecycle`,
      and `prompt queue`.

### Footer And Interaction UI

- 8. Shrink `footer.view.tsx`.
     Files: `packages/opencode/src/cli/cmd/run/footer.view.tsx`
     Why: this file is about 1500 lines and currently owns prompt input, history,
     leader state, keybind dispatch, permission state, question state, focus, layout,
     and footer hints.
     Target: keep it as a view shell. Move prompt control, permission control, and
     question control into smaller modules or reuse fullscreen logic.

- 9. Stop routing permission and question replies through a mini event bus.
     Files: `packages/opencode/src/cli/cmd/run/footer.view.tsx`, `packages/opencode/src/cli/cmd/run/footer.ts`, `packages/opencode/src/cli/cmd/run/stream.ts`
     Why: the current path is
     `view -> RunFooter callback sets -> stream.ts reply handlers -> sdk`.
     Target: the runtime or controller should own one direct reply API and the UI
     should call that directly.

- 10. Deduplicate permission logic with fullscreen.
      Files: `packages/opencode/src/cli/cmd/run/footer.permission.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
      Why: both files implement the same permission stages, path formatting, diff
      rendering decisions, and per-tool copy.
      Target: share the pure state and formatting logic or wrap the fullscreen
      behavior instead of maintaining two copies.

- 11. Deduplicate question logic with fullscreen.
      Files: `packages/opencode/src/cli/cmd/run/footer.question.tsx`, `packages/opencode/src/cli/cmd/run/footer.view.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx`
      Why: both paths implement single-vs-multi select, tabbing, custom answer
      editing, confirm, and reject flows.
      Target: one question controller, two shells at most.

- 12. Deduplicate prompt history and keybind behavior.
      Files: `packages/opencode/src/cli/cmd/run/footer.view.tsx`, `packages/opencode/src/cli/cmd/run/runtime.ts`, `packages/opencode/src/cli/cmd/tui/component/prompt/history.tsx`, `packages/opencode/src/cli/cmd/tui/context/keybind.tsx`, `packages/opencode/src/cli/cmd/tui/component/textarea-keybindings.ts`
      Why: direct mode reimplements history navigation, submit and newline bindings,
      leader handling, and printable binding formatting.
      Target: reuse fullscreen prompt and keybind primitives or extract one shared
      pure helper layer.

- 13. Deduplicate model and variant persistence.
      Files: `packages/opencode/src/cli/cmd/run/runtime.ts`, `packages/opencode/src/cli/cmd/tui/context/local.tsx`
      Why: direct mode reimplements model listing, variant cycling, saved variant
      resolution, and persistence.
      Target: one small shared variant module or one existing owner.

### Rendering And Shared Presentation

- 14. Consolidate tool presentation policy into one place.
      Files: `packages/opencode/src/cli/cmd/run.ts`, `packages/opencode/src/cli/cmd/run/scrollback.tsx`, `packages/opencode/src/cli/cmd/run/footer.permission.tsx`
      Why: tool labels, summaries, file formatting, and tool-specific output rules are
      defined multiple times.
      Target: one typed tool presentation registry used by non-interactive output,
      scrollback output, and permission copy.

- 18. Reduce `scrollback.tsx` to one job.
      Files: `packages/opencode/src/cli/cmd/run/scrollback.tsx`
      Why: this file currently mixes text normalization, tool summary rendering, path
      helpers, filetype helpers, diagnostics lookup, widget components, and writer
      selection.
      Target: keep only entry -> writer selection there and move formatters, widgets,
      and helpers out.

- 19. Remove small repeated helpers and make one shared home for them.
      Files: `packages/opencode/src/cli/cmd/run.ts`, `packages/opencode/src/cli/cmd/run/footer.ts`, `packages/opencode/src/cli/cmd/run/footer.view.tsx`, `packages/opencode/src/cli/cmd/run/footer.permission.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
      Why: `normalizePath()`, `printableBinding()`, exit-command parsing, filetype
      mapping, and diff-view selection are duplicated.
      Target: one pure helper module per concern.

### Edge Features And Test Surface

- 20. Keep trace and splash at the edge.
      Files: `packages/opencode/src/cli/cmd/run/trace.ts`, `packages/opencode/src/cli/cmd/run/splash.ts`, `packages/opencode/src/cli/cmd/run/runtime.ts`, `packages/opencode/src/cli/logo.ts`
      Why: tracing and splash are fine, but they should stay small and non-invasive.
      Target: no business logic or state choreography should depend on them.

- 21. Re-scope the tests after simplification (i've deleted the tests for now)
      Files: `packages/opencode/test/cli/run/*`
      Why: this branch added a large test surface around the current layering. Many of
      those tests will freeze the indirection in place.
      Target: keep end-to-end behavior tests around
      `prompt -> events -> scrollback/footer` results, and delete tests that only
      protect internal wiring.

## Simplified Target Shape

The direct stack should want to look like this:

```text
run.ts
  -> runtime.ts
     -> one session or event controller
        -> scrollback projector
        -> footer view
```

If a module is not one of those four boxes, it should justify why it exists.

## Short Version

The branch is messy because it duplicates too much of the fullscreen session
architecture and then adds another translation layer on top of that duplicate
state. The fastest path to KISS is:

1. keep direct mode as a thin split-footer shell,
2. keep one session model,
3. keep one footer state owner,
4. render typed data instead of parsing synthetic transcript strings,
5. delete duplicate prompt, permission, question, variant, and keybind logic.

## Todo

Todo: collapse runtime and subscriptions -> keep one canonical session model plus a small direct-mode projector -> simplify footer ownership and UI -> consolidate rendering helpers and tool policy -> trim edge features and re-scope tests.
