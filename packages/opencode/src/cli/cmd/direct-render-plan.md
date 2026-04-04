# Direct Scrollback Plan

## Goal

Define the direct/minimal-mode session output architecture so it is specific enough
to implement without guessing.

This plan is intentionally narrower than "build a second fullscreen TUI".
Direct mode must:

- keep scrollback immutable and append-only,
- keep the footer as the only mutable surface,
- follow the same message/part/tool architecture as `tui/routes/session`,
- stay minimal and robust in split-footer mode.

Furthermore, this plan is written as if we dont have anything, but we have lots
of things in direct mode already. This is mostly describing the end state, but
the implementation should be an evolution of the current direct-mode reducer and
scrollback API, not a rewrite from scratch.

## Primary Constraint

The core design constraint is not styling. It is mutability.

- Fullscreen TUI can re-render the whole session tree on every event.
- Direct mode cannot mutate historical rows once they have been committed to
  terminal scrollback.
- Therefore direct mode must project the same session model into two lanes:
  immutable transcript rows in scrollback, and mutable live controls in the
  footer.

Everything in this document follows from that split.

## Architecture To Mirror

The existing fullscreen session route is already the correct product model.

In `tui/routes/session/index.tsx` the transcript is built from message parts:

```ts
const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}
```

And the active prompt area is separate from the transcript:

```tsx
<Show when={permissions().length > 0}>
  <PermissionPrompt request={permissions()[0]} />
</Show>
<Show when={permissions().length === 0 && questions().length > 0}>
  <QuestionPrompt request={questions()[0]} />
</Show>
<Prompt visible={permissions().length === 0 && questions().length === 0} />
```

Direct mode should copy that architecture, not flatten everything into strings at
the event boundary.

The direct-mode equivalent should be:

```ts
const PART_RENDERERS = {
  text: renderAssistantText,
  tool: renderToolPart,
  reasoning: renderReasoningPart,
}
```

And the footer should choose one active body exactly like the fullscreen route:

```tsx
<Switch>
  <Match when={permissions().length > 0}>
    <RunPermissionFooter request={permissions()[0]} />
  </Match>
  <Match when={permissions().length === 0 && questions().length > 0}>
    <RunQuestionFooter request={questions()[0]} />
  </Match>
  <Match when={true}>
    <RunPromptFooter />
  </Match>
</Switch>
```

## Hard Rules

1. Scrollback is append-only.
2. The footer is the only mutable region.
3. Do not append mutable UI state to scrollback.
4. Do not mutate old tool rows when a tool finishes.
5. Do not mutate old assistant rows when more text arrives.
6. If state changes over time, represent that as additional commits, not row
   replacement.
7. Follow the fullscreen message/part/tool split even if the visual result is
   simpler.
8. Do not extract shared UI components now. Copy/adapt fullscreen render policy
   into direct mode and evaluate sharing later.

## What Goes Where

| Concern                                          | Fullscreen TUI                      | Direct minimal mode                                      |
| ------------------------------------------------ | ----------------------------------- | -------------------------------------------------------- |
| User prompt text                                 | `UserMessage` in transcript         | Immutable scrollback row, appended immediately on submit |
| Assistant text                                   | `TextPart`                          | Immutable scrollback progress rows                       |
| Reasoning text                                   | `ReasoningPart`                     | Immutable scrollback progress rows                       |
| Tool lifecycle                                   | `ToolPart` switch                   | Immutable scrollback start/output/final rows             |
| Assistant metadata (`mode`, `model`, `duration`) | Footer-ish metadata at message tail | Footer only                                              |
| Usage/cost tail                                  | Footer/status areas                 | Footer only                                              |
| Pending permission UI                            | `PermissionPrompt` in prompt area   | Footer only                                              |
| Pending question UI                              | `QuestionPrompt` in prompt area     | Footer only                                              |
| Session error                                    | Error block in transcript           | Immutable scrollback error row                           |

The most important implication is this:

- `permission.asked` and `question.asked` are not transcript entries in the
  architectural target.
- They are mutable footer state, just like the fullscreen route.
- Their durable transcript effect is expressed through the tool part that caused
  them and the tool's eventual completed/error state.

## Output Lanes

Direct mode should have two explicit output lanes.

### Lane A: Immutable Scrollback

- Backed by `renderer.writeToScrollback(...)`.
- Receives only durable transcript events.
- Ordered exactly as committed.
- Never updated in place.

### Lane B: Mutable Footer

- Backed by `RunFooter` state.
- Owns prompt input, busy state, queue count, model label, usage tail,
  interrupt/exit hints, and future permission/question UI.
- Can change every frame.

The reducer/output contract should make that split explicit.

```ts
export type FooterView =
  | { type: "prompt" }
  | { type: "permission"; request: PermissionRequest }
  | { type: "question"; request: QuestionRequest }

export type SessionOutput = {
  data: SessionData
  commits: StreamCommit[]
  footer?: {
    patch?: FooterPatch
    view?: FooterView
  }
}
```

Stream wiring should stay simple and one-directional:

```ts
const next = reduceSessionData(...)

for (const commit of next.commits) {
  input.footer.append(commit)
}

if (next.footer?.patch) {
  input.footer.patch(next.footer.patch)
}

if (next.footer?.view) {
  input.footer.present(next.footer.view)
}
```

## Session Output Ownership

Direct mode should mirror the fullscreen session model, but the ownership points
are slightly different.

### User messages

User transcript rows should still be emitted locally from `runPromptQueue()`.

Reason:

- the text already exists in the footer,
- the user expects immediate feedback on submit,
- waiting for server echo would make the UI feel laggy,
- the fullscreen session route does not have this issue because it renders from
  a live synced store.

So the rule is:

- user rows are appended by the prompt queue before `sdk.session.prompt(...)`,
- later `message.updated` user events are used only for role bookkeeping and
  part association,
- direct mode must never append a duplicate user row from synced events.

### Assistant / reasoning / tool output

Assistant-side output should be reducer-owned and event-driven.

- `message.updated` gives message role, usage, and final error state.
- `message.part.delta` and `message.part.updated` drive assistant and reasoning
  output.
- `message.part.updated` for `tool` drives tool lifecycle output.

### Permission / question UI

Pending permission and pending question UI belong to the footer.

- They should not be appended to scrollback as a mutable prompt transcript.
- They should follow the same precedence as fullscreen TUI:
  `permission` first, then `question`, then normal prompt.

The durable session history remains the tool part rows.

## State Model

The reducer state should stay close to the current direct-mode implementation.

```ts
type PartKind = "assistant" | "reasoning"
type MessageRole = "assistant" | "user"

export type SessionData = {
  announced: boolean
  ids: Set<string>
  tools: Set<string>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  role: Map<string, MessageRole>
  msg: Map<string, string>
  part: Map<string, PartKind>
  text: Map<string, string>
  sent: Map<string, number>
  end: Set<string>
  echo: Map<string, Set<string>>
}
```

State responsibilities:

- `announced`: tracks whether assistant activity was already announced to footer.
- `ids`: final/consumed part IDs, used to avoid duplicate transcript rows.
- `tools`: currently running tool part IDs, used to avoid repeated start rows.
- `permissions`: pending permission requests in arrival order.
- `questions`: pending question requests in arrival order.
- `role`: message ID to role mapping from `message.updated`.
- `msg`: part ID to message ID mapping.
- `part`: part ID to logical kind (`assistant` or `reasoning`).
- `text`: full accumulated text per streaming part.
- `sent`: number of characters already emitted to scrollback for a part.
- `end`: parts observed with `time.end` before all role info was known.
- `echo`: bash-output de-dupe cache keyed by assistant message ID.

This is intentionally reducer-only state. Footer state is separate.

## Commit Model

Keep the existing `StreamCommit` shape and extend only where it removes
ambiguity.

```ts
export type StreamPhase = "start" | "progress" | "final"

export type StreamSource = "assistant" | "reasoning" | "tool" | "system"

export type StreamCommit = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  source: StreamSource
  messageID?: string
  partID?: string
  tool?: string
  part?: ToolPart
  gap?: boolean
}
```

Rules:

- `text` is the immutable payload for this commit only.
- `messageID` groups parts under an assistant message when needed.
- `partID` identifies streaming continuity.
- `tool` and `part` let `scrollback-tools.ts` mirror fullscreen `ToolPart`
  rendering by tool name.
- `gap` is a presentation-only newline shim used to recreate fullscreen-style
  top spacing for the first streamed chunk of a part.

## Render Strategy By Content Type

Not every fullscreen renderer can be copied literally.

### Assistant text

Fullscreen uses live markdown/code rendering with mutation.

Direct mode cannot safely do that for arbitrary deltas because historical rows are
immutable. Therefore:

- assistant `progress` rows stay text-first in v1,
- no retroactive markdown reflow,
- no assistant metadata row in scrollback,
- the footer owns model/usage/duration state.

This is the correct compromise for immutable scrollback.

### Reasoning text

Reasoning follows the same streaming rule as assistant text, but with dimmed
styling and a one-time `_Thinking:_` prefix on the first visible chunk.

### Tool output

Tool output is usually emitted only when the tool state is already stable
(`completed` or `error`). That means direct mode can use richer blocks here
without violating immutability.

- text-only tools can render as text blocks,
- `write` can render as a code block,
- `edit` and `apply_patch` can render as diff blocks,
- todo/question summaries can render as structured text blocks.

This is where direct mode should get closest to fullscreen `ToolPart` parity.

## Snapshot Builder Layer

The current direct mode already has `writeToScrollback(...)`, append ordering,
and newline control. The missing piece is a richer snapshot view layer for stable
tool payloads.

Direct mode should not stop at string formatters for completed tool output. For
stable payloads it should build static snapshot views that mirror fullscreen
`ToolPart` structure while respecting immutable scrollback.

### Snapshot architecture

Use three layers.

- `scrollback.ts` owns commit dispatch, newline flags, and snapshot lifecycle.
- `scrollback.snapshot.tsx` (or equivalent) owns static snapshot builders for
  block, code, diff, and structured tool output.
- `scrollback-tools.ts` owns tool data extraction, labels, filetype/diff
  helpers, diagnostics extraction, and generic fallback text helpers.

### Fullscreen references to mirror

The direct snapshot layer should mirror the content structure of the fullscreen
session route:

- `InlineTool`
- `BlockTool`
- `Write`
- `Edit`
- `ApplyPatch`
- `TodoWrite`
- `Question`
- `Task`
- `Diagnostics`

Direct mode should copy their stable content hierarchy and presentation rules,
but not their interactivity.

### Snapshot builder rules

- snapshot builders are only for durable, stable payloads,
- snapshot builders must be pure over `commit`, `ctx.width`, and theme,
- snapshot builders must not read sync/session/router state,
- snapshot builders must not contain hover, click, keyboard, focus,
  expand/collapse, navigation, or portal behavior,
- snapshot builders must not use `scrollbox` inside scrollback; scrollback is
  already the scroll container,
- snapshot builders should use OpenTUI renderable primitives like `box`, `text`,
  `code`, `diff`, and `line_number` where those give a closer match to
  fullscreen `ToolPart`,
- if a stable snapshot is still simplest as text, text renderables remain
  acceptable; the requirement is to preserve component-level structure where it
  materially improves parity,
- assistant and reasoning streaming remain text-first in v1; rich snapshot
  builders are for stable completed tool payloads, not arbitrary deltas.

### Integration with split scrollback

`renderer.writeToScrollback(...)` expects a one-shot `ScrollbackWriter` that
returns a `Renderable` root.

Direct mode therefore needs a dedicated snapshot builder helper that can produce
a static renderable tree for a single commit. That helper may be implemented
with direct renderables or a dedicated one-shot OpenTUI/Solid mount path, but
the result must be:

- synchronous from the writer's point of view,
- non-interactive,
- disposable after the snapshot commit is rendered.

The plan requirement is the builder boundary and resulting snapshot structure,
not one specific mount-helper implementation.

## Event To Output Rules

This section is the actual behavioral spec.

### 1. Prompt submit

`runPromptQueue()` owns user-row emission.

```ts
const text = turn === 0 ? prompt : `\n${prompt}`
input.footer.append({
  kind: "user",
  text,
  phase: "start",
  source: "system",
})
```

Rules:

- first turn uses raw prompt text,
- later turns are prefixed with `\n` to create one blank line between turns,
- the reducer never appends user rows from `message.updated`.

### 2. `message.updated`

For any message in this session:

- store `role[messageID]`,
- replay buffered parts attached to this message if any,
- if role is not `assistant`, emit no transcript rows,
- if role is `assistant`, patch footer status/usage,
- if assistant message has a non-abort error, append one error commit after any
  pending part flush.

Exact rule for assistant metadata:

- keep `mode`, `modelID`, `duration`, and usage in the footer only,
- do not append a separate assistant metadata transcript row.

### 3. `message.part.delta`

For `field !== "text"`:

- ignore for transcript purposes.

For assistant/reasoning text deltas:

- append delta to `data.text[partID]`,
- if part kind is known, emit the unsent tail immediately as a `progress`
  commit,
- if part kind is not yet known, keep buffering until the matching
  `message.part.updated` arrives.

### 4. `message.part.updated` for `text` and `reasoning`

Rules:

- map `part.id -> part.messageID` in `msg`,
- ignore parts already in `ids`,
- if the message role is `user`, mark consumed and drop buffers,
- if the part is reasoning and `thinking === false`, suppress it entirely,
- otherwise register part kind, update `text`, flush unsent tail, and if
  `time.end` exists mark complete and drop buffers.

Important:

- assistant and reasoning do not append a visible `final` row on normal
  completion,
- the only visible `final` row for them is the interrupt marker.

### 5. `message.part.updated` for `tool`

This is the direct-mode analogue of fullscreen `ToolPart`.

#### Running

- append exactly one `start` commit per tool part,
- patch footer status to a human-readable running label,
- do not append duplicate `start` rows if more running updates arrive.

#### Completed

- if the tool never emitted a `start`, synthesize it first,
- append the stable output block if the tool has output worth showing,
- append exactly one `final` summary commit,
- mark part as consumed.

#### Error

- append exactly one `final` error commit,
- do not emit a second transcript row for permission/question rejection if that
  error is already captured by the tool row,
- mark part as consumed.

### 6. `permission.asked` and `permission.replied`

- append nothing to scrollback,
- insert or update the request in `data.permissions`,
- derive `footer.view = { type: "permission", request: data.permissions[0] }`,
- patch footer status to `awaiting permission`,
- on `permission.replied`, remove the request by `requestID`,
- once the active request is removed, immediately re-run footer view selection.

The required behavior is footer-owned permission UI, not auto-reject.

The transcript effect remains:

- existing tool start row,
- eventual tool completion or error row.

### 7. `question.asked`, `question.replied`, `question.rejected`

- append nothing to scrollback,
- insert or update the request in `data.questions`,
- if `data.permissions.length > 0`, keep the permission view active,
- otherwise derive `footer.view = { type: "question", request: data.questions[0] }`,
- patch footer status to `awaiting answer`,
- on `question.replied` or `question.rejected`, remove the request by
  `requestID`,
- once the active request is removed, immediately re-run footer view selection.

This is important because otherwise direct mode would double-log question flow:

- once as a system prompt row,
- again as a `question` tool row.

That would not match fullscreen architecture.

### 8. `session.error`

- append an `error` commit immediately,
- treat it as durable transcript state,
- do not hide it in the footer.

### 9. Abort / interrupt

On abort, for each unfinished assistant/reasoning part:

- emit remaining unsent progress text,
- append exactly one `final` interrupt marker,
- do not append a second assistant error row for `MessageAbortedError`.

## Flush Rules For Streaming Parts

The reducer owns text continuity. The footer owns visual spacing.

Keep the current helper pattern and make the intent explicit.

```ts
function flushPart(data: SessionData, commits: SessionCommit[], partID: string, interrupted = false) {
  const kind = data.part.get(partID)
  if (!kind) return

  const text = data.text.get(partID) ?? ""
  const sent = data.sent.get(partID) ?? 0
  let chunk = text.slice(sent)

  if (sent === 0) {
    chunk = chunk.replace(/^\n+/, "")
    if (kind === "reasoning" && chunk) {
      chunk = `_Thinking:_ ${chunk.replace(/\[REDACTED\]/g, "")}`
    }
  }

  if (chunk) {
    data.sent.set(partID, text.length)
    commits.push({
      kind,
      text: chunk,
      phase: "progress",
      source: kind,
      partID,
    })
  }

  if (interrupted) {
    commits.push({
      kind,
      text: `[${kind}:interrupted]`,
      phase: "final",
      source: kind,
      partID,
    })
  }
}
```

Notes:

- first-chunk leading blank lines are stripped at the reducer layer,
- reasoning redaction cleanup happens before the first visible chunk,
- `gap` insertion is not the reducer's job,
- de-dupe against bash echo still happens only on the first assistant flush.

## Footer Append Rules

The footer is the correct place to handle spacing and micro-batching because that
is a presentation concern, not a session-state concern.

Keep the existing queue/coalescing logic, and make it part of the spec.

```ts
public append(commit: StreamCommit): void {
  if (sameProgressTail(this.queue.at(-1), commit)) {
    this.queue.at(-1)!.text += commit.text
    return
  }

  this.queue.push(commit)
  scheduleFlush()
}
```

And in `flush()`:

```ts
if (isFirstStreamingCommitForPart(item)) {
  this.renderer.writeToScrollback(entryWriter({ ...item, text: "", gap: true }))
}

this.renderer.writeToScrollback(entryWriter(item))
```

Meaning:

- adjacent progress commits for the same part/tool are coalesced,
- the first assistant/reasoning progress commit for a part gets a synthetic gap
  commit first,
- the gap commit is how direct mode recreates fullscreen `marginTop={1}` without
  mutating scrollback.

## Scrollback Snapshot Rules

OpenTUI's split scrollback API already exposes the right newline controls.

```ts
export interface ScrollbackSnapshot {
  root: Renderable
  width?: number
  height?: number
  rowColumns?: number
  startOnNewLine?: boolean
  trailingNewline?: boolean
}
```

And the renderer documents the exact meaning:

```ts
// startOnNewLine adds a newline before this commit if the previous commit
// ended mid-row. trailingNewline adds a newline after this commit's final row.
```

Direct mode should use those flags as follows.

| Commit kind                 | `startOnNewLine` | `trailingNewline` | Reason                                                        |
| --------------------------- | ---------------- | ----------------- | ------------------------------------------------------------- |
| synthetic `gap`             | `false`          | `true`            | Insert one blank line before first streamed part              |
| user row                    | `true`           | `false`           | Prompt text should not force an extra blank line after itself |
| tool `start`                | `true`           | `true`            | Tool header is a standalone block start                       |
| tool `progress`             | `false`          | `false`           | Output may stitch across chunks                               |
| tool `final`                | `true`           | `true`            | Completion/error summary is a standalone line                 |
| assistant `progress`        | `false`          | `false`           | Chunks must stitch together                                   |
| assistant `final` interrupt | `true`           | `true`            | Interrupt marker is a standalone line                         |
| reasoning `progress`        | `false`          | `false`           | Same stitching rule as assistant                              |
| reasoning `final` interrupt | `true`           | `true`            | Interrupt marker is a standalone line                         |
| system/error row            | `true`           | `true`            | Standalone transcript block                                   |

## Direct Tool Renderer Contract

`scrollback-tools.ts` should mirror the fullscreen `ToolPart` switch by tool name,
not by generic string munging only.

```ts
const TOOL_RENDERERS = {
  bash: renderBash,
  read: renderRead,
  write: renderWrite,
  edit: renderEdit,
  apply_patch: renderApplyPatch,
  task: renderTask,
  todowrite: renderTodoWrite,
  question: renderQuestion,
}
```

Fallback stays generic for unknown tools.

The render dispatch in `scrollback.ts` should be explicit:

```ts
function renderToolSnapshot(commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunTheme) {
  switch (commit.tool) {
    case "write":
      return buildCodeSnapshot(commit, ctx, theme)
    case "edit":
    case "apply_patch":
      return buildDiffSnapshot(commit, ctx, theme)
    case "todowrite":
    case "question":
    case "task":
      return buildStructuredSnapshot(commit, ctx, theme)
    default:
      return buildTextSnapshot(commit, ctx, theme)
  }
}
```

This dispatch chooses snapshot shape, not just string formatting.

- `buildTextSnapshot(...)` is for plain text rows and generic fallback blocks.
- `buildCodeSnapshot(...)` is for stable code-oriented payloads like completed
  `write`.
- `buildDiffSnapshot(...)` is for stable diff-oriented payloads like completed
  `edit` and `apply_patch`.
- `buildStructuredSnapshot(...)` is for stable grouped content like completed
  `task`, `todowrite`, and `question`.

### Snapshot shell policy

Direct mode should adapt fullscreen `InlineTool` and `BlockTool` into static
snapshot shells.

- inline snapshots stay line-oriented and are appropriate for `start` rows and
  lightweight summaries,
- block snapshots own top spacing, title row, body rows, and optional error or
  diagnostics tail,
- block snapshots should visually mirror fullscreen `BlockTool`, but without
  hover state, click handlers, or expandable state,
- direct scrollback must not mutate an inline `start` row into a block later;
  when a richer stable block becomes available, append it as a new commit.

### Builder contracts

#### `buildTextSnapshot(...)`

- use for user rows, assistant/reasoning streaming rows, system/error rows,
  generic tool rows, and inline summaries,
- preserve the existing newline and gap semantics from `scrollback.ts`.

#### `buildCodeSnapshot(...)`

- use for completed `write`,
- adapt the fullscreen `Write` content shape,
- render a block shell with a title row,
- render the body with `code` plus `line_number`,
- use the same `filetype(path)` inference rule as fullscreen,
- append up to three diagnostics lines after the code block,
- do not flatten the final block into a single text blob when the richer code
  renderable is available.

#### `buildDiffSnapshot(...)`

- use for completed `edit` and `apply_patch`,
- adapt the fullscreen `Edit`, `ApplyPatch`, and `Diagnostics` content shape,
- use `diff` for stable diff payloads,
- keep the same width rule as fullscreen:
  `stacked => unified`, otherwise `width > 120 ? split : unified`,
- `apply_patch` should render one block per touched file,
- deletion-only entries may use a compact deleted-lines summary instead of an
  empty diff,
- append diagnostics after the diff body when present.

#### `buildStructuredSnapshot(...)`

- use for completed `task`, `todowrite`, and `question`,
- adapt the fullscreen grouped row structure rather than flattening everything
  into one paragraph,
- preserve title row plus grouped content rows for answers, todos, task title,
  toolcall count, and child session metadata.

### Tool rendering policy

| Tool          | Start row             | Progress row                | Final row                                     |
| ------------- | --------------------- | --------------------------- | --------------------------------------------- |
| `bash`        | Header + `$ command`  | stripped stdout/stderr text | none                                          |
| `read`        | inline summary        | none                        | none                                          |
| `write`       | inline summary        | none                        | code block + diagnostics if available         |
| `edit`        | inline summary        | none                        | diff block + diagnostics if available         |
| `apply_patch` | inline summary        | none                        | diff block per touched file                   |
| `task`        | inline summary        | none                        | task summary with child session/toolcall info |
| `todowrite`   | inline summary        | none                        | todo summary block                            |
| `question`    | inline summary        | none while pending          | answered question block on completion         |
| unknown       | generic start summary | raw output if any           | generic completion/error summary              |

Inline-only tools do not append `completed` tails in direct mode. The durable transcript stays on the inline start row unless the tool fails.

### Exact examples

#### Assistant

```text
The reducer should treat scrollback as immutable history and keep active
permission/question UI in the footer only.
```

#### Reasoning

```text
_Thinking:_ Fullscreen already separates transcript rendering from prompt-area UI,
so direct mode should keep that separation instead of logging live prompts.
```

#### Bash

```text
# Shows working tree status in packages/opencode

$ git status --short
 M packages/opencode/src/cli/cmd/run/stream.ts
 M packages/opencode/src/cli/cmd/run/scrollback.ts
```

#### Read

```text
→ Read packages/opencode/src/cli/cmd/run/stream.ts [offset=1, limit=200]
```

#### Question tool

```text
→ Asked 2 questions
└ questions completed · 8s
? Streaming mode
  chunked
? Show tool output
  yes
```

The live selection UI while the question is pending is footer-only.

## Formatter Details By Tool

This section removes ambiguity around the P0 tool set.

### `bash`

- Match fullscreen `Bash` intent.
- Start row format:

```text
# {description or "Shell"}[ in {relative workdir}]
$ {command}
```

- Progress row is raw tool output with ANSI removed.
- If the tool echoed workdir/command at the top, strip that duplicate header.
- Direct mode does not append a bash completion tail; the durable transcript is the header plus streamed output.

### `read`

- Match fullscreen `Read` intent.
- Start row format:

```text
→ Read {path} [primitive input fields except filePath]
```

- Direct mode does not append a final completion row for `read`.

### `write`

- Match fullscreen `Write` intent.
- Start row format:

```text
← Write {path}
```

- Final output should be a stable code block using the written content from
  `part.state.input.content`, followed by up to three diagnostics lines if
  present.
- Prefer a static snapshot block adapted from fullscreen `Write` using `code`
  plus `line_number`, not a flattened text-only representation.
- Use the same filetype inference rule as fullscreen `Write`.
- Do not try to mutate the original `start` row into a block. Append the block
  after completion.

### `edit`

- Match fullscreen `Edit` intent.
- Start row format:

```text
← Edit {path} [replaceAll=true]
```

- Final output should be a diff block using the same width rule as fullscreen:
  `stacked => unified`, otherwise `width > 120 ? split : unified`.
- Prefer a static snapshot block adapted from fullscreen `Edit` using `diff`,
  not a flattened text-only representation.
- Append diagnostics after the diff block if present.

### `apply_patch`

- Match fullscreen `ApplyPatch` intent.
- Start row format:

```text
% Patch {n} file(s)
```

- Final output should append one block per touched file using metadata already
  produced by the tool.
- Prefer static snapshot blocks adapted from fullscreen `ApplyPatch` and
  `Diagnostics` using `diff` where a diff exists.
- File titles must follow fullscreen naming:

```text
# Created {path}
# Deleted {path}
# Moved {from} -> {to}
← Patched {path}
```

### `task`

- Match fullscreen `Task` intent.
- Start row format:

```text
│ {SubagentType} Task - {description}
```

- Final row should include child-session metadata when available:

```text
└ {SubagentType} task completed · {duration}
↳ {title if any}
↳ {toolcall count if any}
↳ session {sessionID if any}
```

- Prefer a structured snapshot block adapted from fullscreen `Task` for the
  completed view.

### `todowrite`

- Match fullscreen `TodoWrite` intent.
- Start row format:

```text
⚙ Updating {n} todo(s)
```

- Final row should summarize total/done/active/pending counts.
- Prefer a structured snapshot block adapted from fullscreen `TodoWrite` for the
  completed view.

### `question`

- Match fullscreen `Question` tool intent.
- Start row format:

```text
→ Asked {n} question(s)
```

- Final block should include each question label and chosen answers.
- Prefer a structured snapshot block adapted from fullscreen `Question` for the
  completed view.
- The interactive selection UI while pending belongs to the footer, not
  scrollback.

## Footer Design For Minimal Mode

The footer should be treated as a shell with one mutable body.

### Footer shell responsibilities

- prompt queue count
- busy/idle state
- model label
- usage tail
- duration
- interrupt and exit affordances

### Footer body responsibilities

- `prompt`: current `RunFooterView` textarea/history behavior
- `permission`: direct-mode version of `PermissionPrompt`
- `question`: direct-mode version of `QuestionPrompt`

The plan does not require extracting shared UI code now. It does require using the
same control-flow architecture as fullscreen.

### Footer view selection

View selection must be deterministic and derived from pending request queues.

```ts
function pickFooterView(data: SessionData): FooterView {
  if (data.permissions.length > 0) {
    return { type: "permission", request: data.permissions[0] }
  }

  if (data.questions.length > 0) {
    return { type: "question", request: data.questions[0] }
  }

  return { type: "prompt" }
}
```

Rules:

- permission always preempts question,
- if a permission arrives while a question view is open, switch to permission on
  the next footer update,
- when the active request is resolved, reveal the next pending permission, else
  the next pending question, else prompt,
- preserve the prompt draft when switching away from `prompt`, and restore it
  when switching back.

### Footer shell layout

`RunFooterView` should become a shell with a swappable body.

```tsx
<box id="run-direct-footer-shell" flexDirection="column">
  <FooterSpacer />
  <FooterFrame>
    <Switch>
      <Match when={view().type === "prompt"}>
        <RunPromptBody />
      </Match>
      <Match when={view().type === "permission"}>
        <RunPermissionBody request={view().request} />
      </Match>
      <Match when={view().type === "question"}>
        <RunQuestionBody request={view().request} />
      </Match>
    </Switch>
    <FooterMeta agent={props.agent} model={props.state().model} />
  </FooterFrame>
  <FooterSeparator />
  <FooterStatusRow />
</box>
```

Rules:

- the bottom status row remains shell-owned in all modes,
- the body owns local controls and local action hints,
- the agent/model meta row remains visible in all modes,
- body overflow must scroll inside the footer body, not by growing the footer
  without bound,
- direct mode does not use the fullscreen `ctrl+f` portal toggle for
  permission/question panels.

### Footer height rules

The footer must resize by body type, but stay bounded.

```ts
const PROMPT_ROWS_MAX = 6
const PERMISSION_ROWS_MAX = 10
const QUESTION_ROWS_MAX = 12
```

Rules:

- prompt mode keeps the current textarea-driven growth behavior,
- permission mode clamps the visible body to `PERMISSION_ROWS_MAX`,
- question mode clamps the visible body to `QUESTION_ROWS_MAX`,
- if body content exceeds the visible budget, render the inner body in a
  `scrollbox`,
- `renderer.footerHeight` should be derived from shell chrome + meta row +
  active body rows.

### Keyboard precedence

The active footer body owns the keyboard.

Rules:

- in `prompt` view, keep current prompt/history/newline/variant/interrupt
  behavior,
- in `permission` or `question` view, body-local keys take precedence,
- while `view !== "prompt"`, do not treat `escape` as session interrupt,
- while `view !== "prompt"`, suspend prompt history and variant-cycle bindings,
- `ctrl+c` keeps global exit semantics in all modes.

This avoids the current `escape` interrupt binding fighting the prompt-style
permission/question interactions.

## Permission UI Spec

The direct-mode permission UI should copy the fullscreen prompt flow, but render
inside the footer body instead of as an overlay.

### Permission stages

The active permission body has three local stages keyed by `request.id`.

```ts
type PermissionStage = "permission" | "always" | "reject"
```

Rules:

- stage resets to `permission` whenever `request.id` changes,
- stage is footer-local UI state and must not live in `SessionData`,
- a local `submitting` flag may prevent duplicate replies, but must not remove
  the body optimistically before the matching `permission.replied` event.

### Permission content mapping

Use the same request-to-display mapping as fullscreen `PermissionPrompt`.

Required mappings:

- `edit`: title `Edit {path}`, body diff preview if available, otherwise `No diff provided`
- `read`: title `Read {path}`, body `Path: {path}`
- `glob`: title `Glob "{pattern}"`, body `Pattern: {pattern}`
- `grep`: title `Grep "{pattern}"`, body `Pattern: {pattern}`
- `list`: title `List {path}`
- `bash`: title `{description or "Shell command"}`, body `$ {command}`
- `task`: title `{SubagentType} Task`, body `◉ {description}`
- `webfetch`: title `WebFetch {url}`
- `websearch`: title `Exa Web Search "{query}"`
- `codesearch`: title `Exa Code Search "{query}"`
- `external_directory`: title `Access external directory {dir}`, body patterns list
- `doom_loop`: title `Continue after repeated failures`
- fallback: title `Call tool {permission}`

### Permission body layout

```text
△ Permission required
  # Shell command
  $ git status --short

[ Allow once ] [ Allow always ] [ Reject ]
⇆ select   enter confirm   esc reject
```

Rules:

- header and option row are fixed,
- long previews render in a scrollable middle body,
- diff content uses the same diff rendering rules as fullscreen permission edit
  preview,
- the body remains inside the footer height budget.

### Permission interactions

At stage `permission`:

- `left` / `right` / `h` / `l` cycles options,
- `enter` confirms selected option,
- `esc` selects reject,
- mouse hover updates selected action,
- mouse up confirms selected action.

At stage `always`:

- render the same confirmation text as fullscreen:
  either wildcard approval text or the explicit patterns list,
- actions are `Confirm` and `Cancel`,
- `esc` cancels back to stage `permission`.

At stage `reject`:

- show a one-line-to-multi-line textarea for feedback,
- `enter` confirms reject with message,
- `esc` cancels back to stage `permission`.

Reject-stage rule:

- if direct mode has access to the current session's `parentID`, mirror
  fullscreen behavior and only require the feedback textarea for child sessions,
- otherwise use the safer direct-mode default: always support reject-with-message.

### Permission reply flow

```ts
onPermissionSelect({ requestID, reply, message? })
  -> sdk.permission.reply(...)
  -> wait for permission.replied
  -> reducer removes request from queue
  -> footer view recalculates
```

The body should remain visible until the queue event confirms the request is gone.

## Question UI Spec

The direct-mode question UI should copy the fullscreen question flow, but render
inside the footer body instead of as an overlay.

### Question local state

Question selection state is footer-local and keyed by `request.id`.

```ts
type QuestionState = {
  tab: number
  answers: string[][]
  custom: string[]
  selected: number
  editing: boolean
}
```

Rules:

- reset local state when `request.id` changes,
- keep reducer/session state limited to pending request queues,
- do not write partially selected answers into `SessionData`.

### Question layout

```text
[ Mode ] [ Output ] [ Confirm ]
Streaming mode
1. chunked
   Incremental output
2. final only
   One final answer
3. Type your own answer

↑↓ select   enter confirm   esc dismiss
```

Rules:

- if there is exactly one single-select question, omit the tab strip and submit
  immediately on selection,
- otherwise render one tab per question plus a final `Confirm` tab,
- the active pane scrolls internally if options exceed the body height budget,
- keep the action hints inside the body, not in the global status row.

### Question interactions

Outside custom-answer editing:

- `left` / `right` / `h` / `l` cycles tabs,
- `tab` / `shift+tab` cycles tabs when multiple questions exist,
- `up` / `down` / `j` / `k` moves selection,
- digits `1` to `9` select the corresponding option,
- `enter` toggles or confirms based on mode,
- `esc` rejects the whole request.

Inside custom-answer editing:

- textarea owns normal typing,
- `enter` saves the custom answer,
- `esc` exits edit mode without dismissing the request,
- if a previous custom answer existed and the new text is empty, remove the old
  custom answer from the answer list.

### Question answer rules

- for single-select one-question prompts, reply immediately after a choice is
  picked,
- for multi-question prompts, only send `sdk.question.reply(...)` from the
  `Confirm` tab,
- when `custom !== false`, append a synthetic `Type your own answer` option,
- for multi-select questions, keep toggled answers in insertion order.

### Question reply flow

```ts
onQuestionReply({ requestID, answers })
  -> sdk.question.reply(...)
  -> wait for question.replied
  -> reducer removes request from queue
  -> footer view recalculates
```

And for dismiss:

```ts
onQuestionReject({ requestID })
  -> sdk.question.reject(...)
  -> wait for question.rejected
  -> reducer removes request from queue
  -> footer view recalculates
```

## Footer Mode Transitions

Mode changes must not lose local prompt state or produce transcript side effects.

```text
prompt -> permission -> prompt
prompt -> question -> prompt
question -> permission -> question
permission -> permission(next queued) -> question -> prompt
```

Rules:

- switching views does not append transcript rows,
- prompt draft text survives non-prompt interludes,
- question local state survives while the same request remains active,
- permission local stage survives while the same request remains active,
- switching to a different request ID resets body-local state.

## Things Direct Mode Should Not Log

To stay aligned with fullscreen behavior and the immutable-log constraint, direct
mode should not append transcript rows for:

- assistant metadata tails (`mode`, `modelID`, `duration`, usage)
- pending permission prompts
- pending question prompts
- prompt hint text
- interrupt affordances
- exit affordances

Those belong to the mutable footer.

## Things Direct Mode Should Ignore For Now

Direct mode session output should continue to ignore unsupported/non-transcript
part types unless there is a concrete product need:

- `step-start`
- `step-finish`
- `subtask`
- `snapshot`
- `patch`
- `agent`
- `retry`
- `compaction`

That matches the current fullscreen transcript mapping, which only renders text,
tool, and reasoning parts in the main session body.

## File-By-File Plan

### `packages/opencode/src/cli/cmd/run/types.ts`

- keep `StreamPhase`, `StreamSource`, and `StreamCommit`
- add `messageID?: string` to commits
- add `FooterView` and `FooterApi.present(view)` as part of the required footer
  shell/body split
- add footer callback types for permission reply and question reply/reject
- do not collapse footer patch state and footer view state into one loose `any`

### `packages/opencode/src/cli/cmd/run/session-data.ts`

- keep reducer ownership of assistant/reasoning/tool/session-error transcript
  output
- keep user-row emission out of the reducer
- handle assistant non-abort message errors explicitly
- keep bash echo de-dupe scoped to the first assistant progress flush
- add pending permission/question queues and derive footer view from them
- do not emit transcript rows for `permission.asked` or `question.asked`

### `packages/opencode/src/cli/cmd/run/stream.ts`

- continue to pipe reducer commits to `footer.append(...)`
- continue to pipe footer patch updates separately
- route permission/question events into footer view state instead of auto-reject
- wire footer permission/question callbacks to `sdk.permission.reply(...)`,
  `sdk.question.reply(...)`, and `sdk.question.reject(...)`

### `packages/opencode/src/cli/cmd/run/footer.ts`

- keep micro-batching and progress coalescing here
- keep synthetic first-part gap injection here
- make this class own `prompt` vs `permission` vs `question` body selection
- preserve prompt draft when view changes away from `prompt`
- disable interrupt/history/variant handling while a non-prompt body owns focus

### `packages/opencode/src/cli/cmd/run/footer.view.tsx`

- split shell layout from prompt body logic
- preserve current history/submit/interrupt behavior for `prompt` mode
- render permission/question bodies inside the shell frame, not as overlays
- do not mix permission/question rendering into scrollback writers

### New direct footer body modules

- add a direct permission body adapted from `tui/routes/session/permission.tsx`
- add a direct question body adapted from `tui/routes/session/question.tsx`
- keep their state local and keyed by request ID
- keep fullscreen-only behavior like `ctrl+f` portal expansion out of direct mode

### `packages/opencode/src/cli/cmd/run/scrollback.ts`

- keep entry dispatch by commit kind and phase
- make newline rules explicit and tested
- own snapshot builder selection and snapshot lifecycle
- use richer renderables only for stable, completed payloads
- do not re-encode stable code/diff/structured tool payloads as plain text once
  the richer snapshot builder exists
- keep assistant/reasoning streaming text-first in v1

### New scrollback snapshot modules

- add `scrollback.snapshot.tsx` (or equivalent) for static snapshot builders and
  snapshot shells
- adapt fullscreen `BlockTool`, `Write`, `Edit`, `ApplyPatch`, `Task`,
  `TodoWrite`, `Question`, and `Diagnostics` into direct scrollback snapshot
  views
- prefer OpenTUI/Solid static components or equivalent renderable trees over
  flattened text for stable tool payloads
- keep snapshot builders synchronous, non-interactive, and free of
  sync/session/router reads

### `packages/opencode/src/cli/cmd/run/scrollback-tools.ts`

- make the tool-name switch mirror fullscreen `ToolPart` ordering
- keep exact start/final labels stable
- move filetype inference, diff-view selection, diagnostics extraction, and
  title helpers here when they are shared across snapshot builders
- add richer completed renderers for `write`, `edit`, and `apply_patch`
- keep generic fallback for unknown tools so no tool output disappears silently

## Required Tests

Extend `packages/opencode/test/cli/run/direct-stream.test.ts` with at least:

1. `appends user prompt immediately and does not duplicate on synced user events`
2. `streams assistant chunks in order for one part`
3. `buffers delta until part kind is known`
4. `suppresses reasoning when thinking is disabled`
5. `emits first assistant chunk with one synthetic gap only once per part`
6. `keeps tool lifecycle ordering start progress final`
7. `emits tool error row once on failure`
8. `flushes remaining assistant text and interrupted marker on abort`
9. `emits assistant message error row for non-abort failures`
10. `does not emit transcript rows for permission.asked`
11. `does not emit transcript rows for question.asked`
12. `keeps bash echo de-dupe scoped to the first assistant flush`
13. `permission takes precedence over question in footer view selection`
14. `replying to permission removes it and reveals next pending view`
15. `question local state resets when request id changes`
16. `escape rejects question or permission instead of interrupting`
17. `prompt draft is preserved across permission and question views`

Add focused `scrollback.ts` tests for snapshot flags:

1. user rows do not append trailing newline
2. tool `start` and `final` rows are standalone blocks
3. assistant progress rows stitch without extra newline
4. gap commits create exactly one blank line before first streamed part

Add focused snapshot-builder tests for stable tool blocks:

1. `write` renders a code snapshot with inferred filetype and diagnostics tail
2. `edit` renders a diff snapshot using the width-based view rule
3. `apply_patch` renders one stable block per touched file with fullscreen-style titles
4. `task`, `todowrite`, and `question` render grouped structured snapshots instead of one flattened line

## Priority

### P0

- explicit immutable-vs-mutable architecture in the direct-mode docs and code
- assistant/reasoning streaming with stable ordering
- tool lifecycle rows in scrollback
- static snapshot builder layer for stable tool output, adapted from fullscreen
  `ToolPart`
- tool-name renderer mapping that mirrors fullscreen `ToolPart`
- no duplicate transcript rows for permission/question live prompts
- footer-owned permission UI with fullscreen-equivalent stages and actions
- footer-owned question UI with fullscreen-equivalent selection and reply flow

### P1

- richer visual parity and polish for code/diff/structured snapshot blocks
- better user file badge rendering

### P2

- resume/backfill of historical transcript
- text/spacing polish
- optional markdown-aware segmentation for assistant text if needed later

## Non-Goals

- turning direct mode into fullscreen TUI with one renderer switch
- mutating historical scrollback rows
- transcript rows for live permission/question prompts
- multiple streaming policies
- extraction of shared fullscreen/direct component layers right now

## V1 TODO

**Types And Reducer**

- [x] add `FooterView`, footer callbacks, and any remaining structured commit fields in `run/types.ts`
- [x] extend `SessionData` with the pending permission/question queues and any remaining reducer-owned maps/sets
- [x] emit assistant and reasoning progress commits with correct buffering, flushing, and interrupt handling
- [x] emit tool `start`, output, `final`, and error commits in stable order
- [x] emit session error commits and keep assistant metadata footer-only
- [x] keep user-row emission local while preventing duplicate synced transcript rows

**Stream Wiring**

- [x] wire `stream.ts` to forward reducer commits, footer patches, and footer view changes
- [x] replace direct-mode permission auto-reject with footer-owned permission handling
- [x] wire footer permission actions to `sdk.permission.reply(...)`
- [x] wire footer question actions to `sdk.question.reply(...)` and `sdk.question.reject(...)`

**Footer Shell**

- [x] split the footer into a shell with `prompt`, `permission`, and `question` bodies
- [x] implement deterministic footer view selection with `permission > question > prompt`
- [x] preserve prompt draft when switching away from `prompt` and restore it when switching back
- [x] give non-prompt footer bodies keyboard ownership while keeping `ctrl+c` global
- [x] derive footer height from the active body and clamp overflow with inner scrolling

**Permission UI**

- [x] implement the direct permission request content mapping for the supported tool/permission types
- [x] implement the base `permission` stage with option selection and confirm behavior
- [x] implement the `always` confirmation stage
- [x] implement the `reject` feedback stage
- [x] keep the active permission body visible until the matching `permission.replied` event removes it from the queue

**Question UI**

- [x] implement question tabs and the confirm tab for multi-question prompts
- [x] implement option movement, selection, digit shortcuts, and single-select immediate submit behavior
- [x] implement custom answer entry and edit mode
- [x] implement reply flow for confirmed answers
- [x] implement reject flow on dismiss

**Scrollback Rendering**

- [x] keep scrollback append-only with no live permission/question transcript rows
- [x] implement the newline and gap rules exactly as specified
- [x] add a static snapshot builder layer for text, code, diff, and structured tool output
- [x] adapt fullscreen `BlockTool`, `Write`, `Edit`, `ApplyPatch`, `Task`, `TodoWrite`, `Question`, and `Diagnostics` into direct scrollback snapshot views
- [x] keep snapshot builders non-interactive and free of sync/session/router reads
- [x] finish P0 assistant, reasoning, tool lifecycle, and error rendering in `scrollback.ts`
- [x] finish P0 tool formatters for `bash`, `read`, `write`, `edit`, `apply_patch`, `task`, `todowrite`, and `question`

**Tests**

- [x] add the reducer/footer coverage listed in the `direct-stream.test.ts` section of this plan
- [x] add the `scrollback.ts` snapshot and newline tests listed in this plan
- [x] add snapshot-builder tests for code, diff, and structured tool blocks
- [x] add focused tests for footer view precedence, prompt-draft preservation, and non-prompt keyboard ownership

**Manual Verification**

- [ ] verify prompt -> assistant streaming -> tool output -> prompt loop
- [ ] verify permission flow end to end in the footer
- [ ] verify question flow end to end in the footer
- [ ] verify interrupt, resize, and long-output behavior in split-footer mode

## Ordered Execution Checklist

This checklist is additive. It does not replace the bucketed `V1 TODO` above.

Use it to decide implementation order while still tracking completion against the
bucketed TODO sections.

### Tracking Rule

- [ ] only mark a TODO item done when it matches this plan, not just because the
      current branch already has some version of it
- [ ] do not treat a partial branch implementation as complete by default

### Step 1: Types Contract First

Files:
`run/types.ts`

Links to bucketed TODO:

- `Types And Reducer` -> `add FooterView, footer callbacks, and any remaining structured commit fields in run/types.ts`

This step starts:

- `Stream Wiring` -> `wire stream.ts to forward reducer commits, footer patches, and footer view changes`
- `Footer Shell` -> `split the footer into a shell with prompt, permission, and question bodies`

Why now:

- this is the contract everything else hangs off: reducer output, scrollback
  builders, stream plumbing, and footer view switching

### Step 2: Align SessionData And Reducer To The Plan

Files:
`run/session-data.ts`

Links to bucketed TODO:

- `Types And Reducer` -> `extend SessionData with the pending permission/question queues and any remaining reducer-owned maps/sets`
- `Types And Reducer` -> `emit assistant and reasoning progress commits with correct buffering, flushing, and interrupt handling`
- `Types And Reducer` -> `emit tool start, output, final, and error commits in stable order`
- `Types And Reducer` -> `emit session error commits and keep assistant metadata footer-only`
- `Types And Reducer` -> `keep user-row emission local while preventing duplicate synced transcript rows`
- `Scrollback Rendering` -> `keep scrollback append-only with no live permission/question transcript rows`

Why now:

- this is the real architecture change
- it aligns the current reducer with the plan before more UI work lands on top

### Step 3: Establish The Scrollback Snapshot Architecture

Files:
`run/scrollback.ts`, `run/scrollback-tools.ts`, new `run/scrollback.snapshot.tsx` or equivalent

Links to bucketed TODO:

- `Scrollback Rendering` -> `implement the newline and gap rules exactly as specified`
- `Scrollback Rendering` -> `add a static snapshot builder layer for text, code, diff, and structured tool output`
- `Scrollback Rendering` -> `adapt fullscreen BlockTool, Write, Edit, ApplyPatch, Task, TodoWrite, Question, and Diagnostics into direct scrollback snapshot views`
- `Scrollback Rendering` -> `keep snapshot builders non-interactive and free of sync/session/router reads`

This step starts:

- `Scrollback Rendering` -> `finish P0 assistant, reasoning, tool lifecycle, and error rendering in scrollback.ts`
- `Scrollback Rendering` -> `finish P0 tool formatters for bash, read, write, edit, apply_patch, task, todowrite, and question`

Why now:

- this was previously under-specified and should be explicit before more footer
  UI work piles on top
- this is where direct mode gets closest to fullscreen `ToolPart` parity

### Step 4: Rewrite The Reducer And Scrollback Tests Around The New Contract

Files:
`session-data.test.ts`, `direct-stream.test.ts`, `scrollback.test.ts`, `direct-footer.test.ts`

Links to bucketed TODO:

- `Tests` -> `add the reducer/footer coverage listed in the direct-stream.test.ts section of this plan`
- `Tests` -> `add the scrollback.ts snapshot and newline tests listed in this plan`
- `Tests` -> `add snapshot-builder tests for code, diff, and structured tool blocks`

Why now:

- these tests lock the corrected reducer and scrollback contracts before stream
  and footer UI work continue

### Step 5: Rewire `stream.ts` To Be Pure Plumbing

Files:
`run/stream.ts`

Links to bucketed TODO:

- `Stream Wiring` -> `wire stream.ts to forward reducer commits, footer patches, and footer view changes`
- `Stream Wiring` -> `replace direct-mode permission auto-reject with footer-owned permission handling`
- `Stream Wiring` -> `wire footer permission actions to sdk.permission.reply(...)`
- `Stream Wiring` -> `wire footer question actions to sdk.question.reply(...) and sdk.question.reject(...)`

Why now:

- once the reducer and scrollback contracts are correct, `stream.ts` should stay
  simple and stable

### Step 6: Turn The Footer Into A Shell With Swappable Bodies

Files:
`run/footer.ts`, `run/footer.view.tsx`

Links to bucketed TODO:

- `Footer Shell` -> `split the footer into a shell with prompt, permission, and question bodies`
- `Footer Shell` -> `implement deterministic footer view selection with permission > question > prompt`
- `Footer Shell` -> `preserve prompt draft when switching away from prompt and restore it when switching back`
- `Footer Shell` -> `give non-prompt footer bodies keyboard ownership while keeping ctrl+c global`
- `Footer Shell` -> `derive footer height from the active body and clamp overflow with inner scrolling`
- `Tests` -> `add focused tests for footer view precedence, prompt-draft preservation, and non-prompt keyboard ownership`

Why now:

- this gets the shell architecture in place before the detailed permission and
  question interactions

Completion note:

- placeholder permission and question bodies are sufficient to prove the shell
  contract at this step

### Step 7: Build The Permission Body

Files:
new direct permission body module plus `footer.view.tsx` and `footer.ts` as needed

Links to bucketed TODO:

- all `Permission UI` TODO items

Why now:

- permission is the currently broken behavior and it preempts question in the
  footer model

### Step 8: Build The Question Body

Files:
new direct question body module plus `footer.view.tsx` and `footer.ts` as needed

Links to bucketed TODO:

- all `Question UI` TODO items

Why now:

- it depends on the shell and view-switching model, and is safer to land after
  permission is stable

### Step 9: Finish Tool Parity, Run End-To-End Checks, And Close Gaps

Files:
whichever of `run/scrollback.ts`, `run/scrollback.snapshot.tsx`, `run/scrollback-tools.ts`, tests, and runtime wiring still need cleanup

Links to bucketed TODO:

- remaining `Scrollback Rendering` items
- remaining `Tests` gaps
- all `Manual Verification` items

Why now:

- this is the parity and verification sweep after reducer, stream, footer
  shell, and footer bodies are all in place

### Compact TODO Mapping

- [x] Step 1 maps to `Types And Reducer` item 1
- [x] Step 2 maps to `Types And Reducer` items 2-6 and part of `Scrollback Rendering` item 1
- [x] Step 3 maps to `Scrollback Rendering` items 2-5 and starts items 6-7
- [x] Step 4 maps to `Tests` items 1-2 and the snapshot-builder test item
- [x] Step 5 maps to `Stream Wiring` items 1-4
- [x] Step 6 maps to `Footer Shell` items 1-5 and `Tests` item 4
- [x] Step 7 maps to all `Permission UI` items
- [x] Step 8 maps to all `Question UI` items
- [ ] Step 9 closes remaining `Scrollback Rendering`, remaining `Tests`, and all `Manual Verification` items
  - [ ] polish session scrollback
  - [ ] overwriting footer with errors - /home/simon/.local/bin/script-run info footer-error (errors are rendering above the footer)
  - [ ] thinking doesn't render properly
  - [ ] spacing [new lines] between parts is inconsistent and wrong

### Do Not Count Early

- [ ] do not count permission and question done at Step 2 just because the queues exist
- [ ] do not count scrollback rendering done at Step 3 just because dispatch functions exist
- [ ] do not count footer shell done at Step 6 just because view switching compiles

When every item above is done, direct scrollback mode should be ready to ship as
v1.
