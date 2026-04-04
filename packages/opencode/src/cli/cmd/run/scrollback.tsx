/** @jsxImportSource @opentui/solid */

import path from "path"
import stripAnsi from "strip-ansi"
import {
  SyntaxStyle,
  TextAttributes,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { createScrollbackWriter, type JSX } from "@opentui/solid"
import { For, Show } from "solid-js"
import { Filesystem } from "../../../util/filesystem"
import { Locale } from "../../../util/locale"
import { toolDiffView, toolFiletype, toolView } from "./tool"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

type ToolDict = Record<string, unknown>

function dict(v: unknown): ToolDict {
  if (!v || typeof v !== "object") {
    return {}
  }

  return v as ToolDict
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function num(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return
  }

  return v
}

function done(name: string, time: string): string {
  if (!time) {
    return `└ ${name} completed`
  }

  return `└ ${name} completed · ${time}`
}

type ToolCtx = {
  raw: string
  name: string
  data: ToolDict
  meta: ToolDict
  state: ToolDict
  status: string
  error: string
}

type Draw = (ctx: ToolCtx) => string
type Stage = StreamCommit["phase"]
type Spec = Partial<Record<Stage, Draw>>

function view(input: string): string {
  if (!input) {
    return ""
  }

  const cwd = process.cwd()
  const abs = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const rel = path.relative(cwd, abs)

  if (!rel) {
    return "."
  }

  if (!rel.startsWith("..")) {
    return rel
  }

  return abs
}

function viewPath(input: string): string {
  return view(input)
}

function toolDiagnostics(meta: ToolDict, file: string): string[] {
  const all = dict(meta.diagnostics)
  const key = Filesystem.normalizePath(file)
  const list = arr(all[key]).map(dict)
  return list
    .filter((item) => item.severity === 1)
    .slice(0, 3)
    .map((item) => {
      const range = dict(item.range)
      const start = dict(range.start)
      const line = num(start.line)
      const char = num(start.character)
      const msg = text(item.message)
      if (line === undefined || char === undefined) {
        return `Error ${msg}`.trim()
      }

      return `Error [${line + 1}:${char + 1}] ${msg}`.trim()
    })
}

function info(data: ToolDict, skip: string[] = []): string {
  const list = Object.entries(data).filter(([key, val]) => {
    if (skip.includes(key)) {
      return false
    }

    return typeof val === "string" || typeof val === "number" || typeof val === "boolean"
  })

  if (list.length === 0) {
    return ""
  }

  return `[${list.map(([key, val]) => `${key}=${val}`).join(", ")}]`
}

function span(ctx: ToolCtx): string {
  const time = dict(ctx.state.time)
  const start = num(time.start)
  const end = num(time.end)
  if (start === undefined || end === undefined || end <= start) {
    return ""
  }

  return Locale.duration(end - start)
}

function fail(ctx: ToolCtx): string {
  if (ctx.error) {
    return `✖ ${ctx.name} failed: ${ctx.error}`
  }

  const state = text(ctx.state.error).trim()
  if (state) {
    return `✖ ${ctx.name} failed: ${state}`
  }

  const raw = ctx.raw.trim()
  if (raw) {
    return `✖ ${ctx.name} failed: ${raw}`
  }

  return `✖ ${ctx.name} failed`
}

function start(ctx: ToolCtx): string {
  const extra = info(ctx.data)
  if (!extra) {
    return `⚙ ${ctx.name}`
  }

  return `⚙ ${ctx.name} ${extra}`
}

function progress(ctx: ToolCtx): string {
  return ctx.raw
}

function final(ctx: ToolCtx): string {
  const status = ctx.status
  if (status === "error") {
    return fail(ctx)
  }

  if (status && status !== "completed") {
    return ctx.raw.trim()
  }

  return done(ctx.name, span(ctx))
}

function bashStart(ctx: ToolCtx): string {
  const cmd = text(ctx.data.command)
  const desc = text(ctx.data.description) || "Shell"
  const wd = text(ctx.data.workdir)
  const dir = wd && wd !== "." ? view(wd) : ""
  const title = dir && !desc.includes(dir) ? `${desc} in ${dir}` : desc

  if (!cmd) {
    return `# ${title}`
  }

  return `# ${title}\n$ ${cmd}`
}

function bashProgress(ctx: ToolCtx): string {
  const out = stripAnsi(ctx.raw)
  const cmd = text(ctx.data.command).trim()
  if (!cmd) {
    return out
  }

  const wdRaw = text(ctx.data.workdir).trim()
  const wd = wdRaw ? view(wdRaw) : ""
  const lines = out.split("\n")
  const first = (lines[0] || "").trim()
  const second = (lines[1] || "").trim()

  if (wd && (first === wd || first === wdRaw) && second === cmd) {
    const body = lines.slice(2).join("\n")
    if (body.length > 0) {
      return body
    }
    return out
  }

  if (first === cmd || first === `$ ${cmd}`) {
    const body = lines.slice(1).join("\n")
    if (body.length > 0) {
      return body
    }
    return out
  }

  if (wd && (first === `${wd} ${cmd}` || first === `${wdRaw} ${cmd}`)) {
    const body = lines.slice(1).join("\n")
    if (body.length > 0) {
      return body
    }
    return out
  }

  return out
}

function bashFinal(ctx: ToolCtx): string {
  const code = num(ctx.meta.exitCode) ?? num(ctx.meta.exit_code)
  const time = span(ctx)
  if (code === undefined) {
    return done("bash", time)
  }

  return `└ bash completed (exit ${code})${time ? ` · ${time}` : ""}`
}

function readStart(ctx: ToolCtx): string {
  const file = view(text(ctx.data.filePath))
  const extra = info(ctx.data, ["filePath"])
  const tail = extra ? ` ${extra}` : ""
  return `→ Read ${file}${tail}`.trim()
}

function writeStart(ctx: ToolCtx): string {
  return `← Write ${view(text(ctx.data.filePath))}`.trim()
}

function editStart(ctx: ToolCtx): string {
  const flag = info({ replaceAll: ctx.data.replaceAll })
  const tail = flag ? ` ${flag}` : ""
  return `← Edit ${view(text(ctx.data.filePath))}${tail}`.trim()
}

function patchStart(ctx: ToolCtx): string {
  const files = arr(ctx.meta.files)
  if (files.length === 0) {
    return "% Patch"
  }

  return `% Patch ${files.length} file${files.length === 1 ? "" : "s"}`
}

function patchLine(data: ToolDict): string {
  const type = text(data.type)
  const rel = text(data.relativePath)
  const file = text(data.filePath)

  if (type === "add") {
    return `+ Created ${rel || view(file)}`
  }

  if (type === "delete") {
    return `- Deleted ${rel || view(file)}`
  }

  if (type === "move") {
    const from = view(file)
    const to = rel || view(text(data.movePath))
    return `→ Moved ${from} → ${to}`
  }

  return `~ Patched ${rel || view(file)}`
}

function patchFinal(ctx: ToolCtx): string {
  const files = arr(ctx.meta.files).map(dict)
  const head = done("patch", span(ctx))
  if (files.length === 0) {
    return head
  }

  const rows = [head, ...files.slice(0, 6).map(patchLine)]
  if (files.length > 6) {
    rows.push(`... and ${files.length - 6} more`)
  }

  return rows.join("\n")
}

function taskStart(ctx: ToolCtx): string {
  const kind = Locale.titlecase(text(ctx.data.subagent_type) || "general")
  const desc = text(ctx.data.description)
  if (!desc) {
    return `│ ${kind} Task`
  }

  return `│ ${kind} Task — ${desc}`
}

function taskFinal(ctx: ToolCtx): string {
  const kind = Locale.titlecase(text(ctx.data.subagent_type) || "general")
  const head = done(`${kind} task`, span(ctx))
  const rows: string[] = [head]

  const title = text(ctx.state.title)
  if (title) {
    rows.push(`↳ ${title}`)
  }

  const calls = num(ctx.meta.toolcalls) ?? num(ctx.meta.toolCalls) ?? num(ctx.meta.calls)
  if (calls !== undefined) {
    rows.push(`↳ ${Locale.number(calls)} toolcall${calls === 1 ? "" : "s"}`)
  }

  const sid = text(ctx.meta.sessionId) || text(ctx.meta.sessionID)
  if (sid) {
    rows.push(`↳ session ${sid}`)
  }

  return rows.join("\n")
}

function todoStart(ctx: ToolCtx): string {
  const todos = arr(ctx.data.todos)
  if (todos.length === 0) {
    return "⚙ Updating todos..."
  }

  return `⚙ Updating ${todos.length} todo${todos.length === 1 ? "" : "s"}`
}

function todoFinal(ctx: ToolCtx): string {
  const list = arr(ctx.data.todos).map(dict)
  if (list.length === 0) {
    return done("todos", span(ctx))
  }

  const doneN = list.filter((item) => text(item.status) === "completed").length
  const runN = list.filter((item) => text(item.status) === "in_progress").length
  const left = list.length - doneN - runN
  const tail = [`${list.length} total`]
  if (doneN > 0) {
    tail.push(`${doneN} done`)
  }
  if (runN > 0) {
    tail.push(`${runN} active`)
  }
  if (left > 0) {
    tail.push(`${left} pending`)
  }

  return `${done("todos", span(ctx))} · ${tail.join(" · ")}`
}

function questionStart(ctx: ToolCtx): string {
  const count = arr(ctx.data.questions).length
  return `→ Asked ${count} question${count === 1 ? "" : "s"}`
}

function questionFinal(ctx: ToolCtx): string {
  const q = arr(ctx.data.questions).map(dict)
  const a = arr(ctx.meta.answers)
  if (q.length === 0) {
    return done("questions", span(ctx))
  }

  const rows = [done("questions", span(ctx))]
  for (const [i, item] of q.slice(0, 4).entries()) {
    const prompt = text(item.question)
    const reply = arr(a[i]).filter((v): v is string => typeof v === "string")
    rows.push(`? ${prompt || `Question ${i + 1}`}`)
    rows.push(`  ${reply.length > 0 ? reply.join(", ") : "(no answer)"}`)
  }

  if (q.length > 4) {
    rows.push(`... and ${q.length - 4} more`)
  }

  return rows.join("\n")
}

function skillStart(ctx: ToolCtx): string {
  return `→ Skill "${text(ctx.data.name)}"`
}

function globStart(ctx: ToolCtx): string {
  const pattern = text(ctx.data.pattern)
  const head = pattern ? `✱ Glob "${pattern}"` : "✱ Glob"
  const dir = text(ctx.data.path)
  if (!dir) {
    return head
  }

  return `${head} in ${view(dir)}`
}

function grepStart(ctx: ToolCtx): string {
  const pattern = text(ctx.data.pattern)
  const head = pattern ? `✱ Grep "${pattern}"` : "✱ Grep"
  const dir = text(ctx.data.path)
  if (!dir) {
    return head
  }

  return `${head} in ${view(dir)}`
}

function listStart(ctx: ToolCtx): string {
  const dir = text(ctx.data.path)
  if (!dir) {
    return "→ List"
  }

  return `→ List ${view(dir)}`
}

function webfetchStart(ctx: ToolCtx): string {
  const url = text(ctx.data.url)
  if (!url) {
    return "% WebFetch"
  }

  return `% WebFetch ${url}`
}

function codesearchStart(ctx: ToolCtx): string {
  const query = text(ctx.data.query)
  if (!query) {
    return "◇ Exa Code Search"
  }

  return `◇ Exa Code Search "${query}"`
}

function websearchStart(ctx: ToolCtx): string {
  const query = text(ctx.data.query)
  if (!query) {
    return "◈ Exa Web Search"
  }

  return `◈ Exa Web Search "${query}"`
}

const toolMap: Record<string, Spec> = {
  bash: {
    start: bashStart,
    progress: bashProgress,
    final: bashFinal,
  },
  read: {
    start: readStart,
  },
  write: {
    start: writeStart,
  },
  edit: {
    start: editStart,
  },
  apply_patch: {
    start: patchStart,
    final: patchFinal,
  },
  task: {
    start: taskStart,
    final: taskFinal,
  },
  todowrite: {
    start: todoStart,
    final: todoFinal,
  },
  question: {
    start: questionStart,
    final: questionFinal,
  },
  skill: {
    start: skillStart,
  },
  glob: {
    start: globStart,
  },
  grep: {
    start: grepStart,
  },
  list: {
    start: listStart,
  },
  webfetch: {
    start: webfetchStart,
  },
  codesearch: {
    start: codesearchStart,
  },
  websearch: {
    start: websearchStart,
  },
}

function toolCtx(commit: StreamCommit, raw: string): ToolCtx {
  const state = dict(commit.part?.state)
  return {
    raw,
    name: commit.tool || commit.part?.tool || "tool",
    data: dict(state.input),
    meta: dict(state.metadata),
    state,
    status: commit.toolState ?? text(state.status),
    error: (commit.toolError ?? "").trim(),
  }
}

function formatToolEntry(commit: StreamCommit, raw: string): string {
  const ctx = toolCtx(commit, raw)
  const view = toolView(ctx.name)

  if (commit.phase === "progress" && !view.output) {
    return ""
  }

  if (commit.phase === "final") {
    const status = ctx.status
    if (status === "error") {
      return fail(ctx)
    }

    if (!view.final) {
      return ""
    }

    if (status && status !== "completed") {
      return ctx.raw.trim()
    }
  }

  const spec = toolMap[ctx.name] ?? {}
  const draw = spec[commit.phase]
  if (draw) {
    return draw(ctx)
  }

  if (commit.phase === "start") {
    return start(ctx)
  }

  if (commit.phase === "progress") {
    return progress(ctx)
  }

  return final(ctx)
}

// ---------------------------------------------------------------------------
// Snapshot rendering
// ---------------------------------------------------------------------------

type Flags = {
  startOnNewLine: boolean
  trailingNewline: boolean
}

type Paint = {
  fg: ColorInput
  attrs?: number
}

type CodeInput = {
  title: string
  content: string
  filetype?: string
  diagnostics: string[]
}

type DiffInput = {
  title: string
  diff?: string
  filetype?: string
  deletions?: number
  diagnostics: string[]
}

type TaskInput = {
  title: string
  rows: string[]
  tail: string
}

type TodoInput = {
  items: Array<{
    status: string
    content: string
  }>
  tail: string
}

type QuestionInput = {
  items: Array<{
    question: string
    answer: string
  }>
  tail: string
}

type Measure = {
  widthColsMax: number
}

type MeasureNode = {
  textBufferView?: {
    measureForDimensions(width: number, height: number): Measure | null
  }
  getChildren?: () => unknown[]
}

let syntax: SyntaxStyle | undefined

function codeStyle() {
  syntax ??= SyntaxStyle.create()
  return syntax
}

function failed(commit: StreamCommit): boolean {
  return commit.kind === "tool" && (commit.toolState === "error" || commit.part?.state.status === "error")
}

function look(commit: StreamCommit, theme: RunEntryTheme): Paint {
  if (commit.kind === "user") {
    return {
      fg: theme.user.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (failed(commit)) {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (commit.phase === "final") {
    return {
      fg: theme.system.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "assistant") {
    return { fg: theme.assistant.body }
  }

  if (commit.kind === "reasoning") {
    return {
      fg: theme.reasoning.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "error") {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (commit.kind === "tool") {
    return { fg: theme.tool.body }
  }

  return { fg: theme.system.body }
}

function cols(ctx: ScrollbackRenderContext): number {
  return Math.max(1, Math.trunc(ctx.width))
}

function leaf(node: unknown): MeasureNode | undefined {
  if (!node || typeof node !== "object") {
    return
  }

  const next = node as MeasureNode
  if (next.textBufferView) {
    return next
  }

  const list = next.getChildren?.() ?? []
  for (const child of list) {
    const out = leaf(child)
    if (out) {
      return out
    }
  }
}

function fit(snapshot: ScrollbackSnapshot, ctx: ScrollbackRenderContext, gap = false) {
  if (gap) {
    snapshot.width = 0
    snapshot.rowColumns = 0
    return snapshot
  }

  const node = leaf(snapshot.root)
  const width = cols(ctx)
  const box = node?.textBufferView?.measureForDimensions(width, Math.max(1, snapshot.height ?? 1))
  const rowColumns = Math.max(1, Math.min(width, box?.widthColsMax ?? 0))

  snapshot.width = rowColumns
  snapshot.rowColumns = rowColumns
  return snapshot
}

function full(node: () => JSX.Element, ctx: ScrollbackRenderContext, flags: Flags) {
  return createScrollbackWriter(node, {
    width: cols(ctx),
    rowColumns: cols(ctx),
    startOnNewLine: flags.startOnNewLine,
    trailingNewline: flags.trailingNewline,
  })(ctx)
}

function TextEntry(props: { body: string; fg: ColorInput; attrs?: number }) {
  return (
    <text width="100%" wrapMode="word" fg={props.fg} attributes={props.attrs}>
      {props.body}
    </text>
  )
}

function ReasoningEntry(props: { body: string; theme: RunEntryTheme }) {
  return (
    <code
      width="100%"
      filetype="markdown"
      drawUnstyledText={false}
      streaming={true}
      syntaxStyle={codeStyle()}
      content={props.body}
      conceal={false}
      wrapMode="word"
      fg={props.theme.reasoning.body}
    />
  )
}

function Diagnostics(props: { theme: RunEntryTheme; lines: string[] }) {
  return (
    <Show when={props.lines.length > 0}>
      <box>
        <For each={props.lines}>{(line) => <text fg={props.theme.error.body}>{line}</text>}</For>
      </box>
    </Show>
  )
}

function BlockTool(props: { theme: RunEntryTheme; title: string; children: JSX.Element }) {
  return (
    <box
      border={["left"]}
      borderColor={props.theme.system.body}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
    >
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.title}
      </text>
      {props.children}
    </box>
  )
}

function CodeTool(props: { theme: RunEntryTheme; data: CodeInput }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <line_number fg={props.theme.system.body} minWidth={3} paddingRight={1}>
        <code
          conceal={false}
          fg={props.theme.assistant.body}
          filetype={props.data.filetype}
          syntaxStyle={codeStyle()}
          content={props.data.content}
          drawUnstyledText={true}
          wrapMode="word"
        />
      </line_number>
      <Diagnostics theme={props.theme} lines={props.data.diagnostics} />
    </BlockTool>
  )
}

function DiffTool(props: { theme: RunEntryTheme; data: DiffInput; view: "unified" | "split" }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <Show
        when={props.data.diff?.trim()}
        fallback={
          <text fg={props.theme.error.body}>
            -{props.data.deletions ?? 0} line{props.data.deletions === 1 ? "" : "s"}
          </text>
        }
      >
        <box paddingLeft={1}>
          <diff
            diff={props.data.diff ?? ""}
            view={props.view}
            filetype={props.data.filetype}
            syntaxStyle={codeStyle()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={props.theme.assistant.body}
          />
        </box>
      </Show>
      <Diagnostics theme={props.theme} lines={props.data.diagnostics} />
    </BlockTool>
  )
}

function TaskTool(props: { theme: RunEntryTheme; data: TaskInput }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <box>
        <For each={props.data.rows}>{(line) => <text fg={props.theme.assistant.body}>{line}</text>}</For>
      </box>
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
    </BlockTool>
  )
}

function todoMark(status: string): string {
  if (status === "completed") {
    return "[x]"
  }
  if (status === "in_progress") {
    return "[>]"
  }
  if (status === "cancelled") {
    return "[-]"
  }
  return "[ ]"
}

function TodoTool(props: { theme: RunEntryTheme; data: TodoInput }) {
  return (
    <BlockTool theme={props.theme} title="# Todos">
      <box>
        <For each={props.data.items}>
          {(item) => (
            <text fg={props.theme.assistant.body}>
              {todoMark(item.status)} {item.content}
            </text>
          )}
        </For>
      </box>
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
    </BlockTool>
  )
}

function QuestionTool(props: { theme: RunEntryTheme; data: QuestionInput }) {
  return (
    <BlockTool theme={props.theme} title="# Questions">
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
      <box gap={1}>
        <For each={props.data.items}>
          {(item) => (
            <box flexDirection="column">
              <text fg={props.theme.system.body}>{item.question}</text>
              <text fg={props.theme.assistant.body}>{item.answer}</text>
            </box>
          )}
        </For>
      </box>
    </BlockTool>
  )
}

function textWriter(body: string, commit: StreamCommit, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  const style = look(commit, theme)
  return (ctx) =>
    fit(
      createScrollbackWriter(() => <TextEntry body={body} fg={style.fg} attrs={style.attrs} />, {
        width: cols(ctx),
        startOnNewLine: flags.startOnNewLine,
        trailingNewline: flags.trailingNewline,
      })(ctx),
      ctx,
      commit.gap,
    )
}

function reasoningWriter(body: string, commit: StreamCommit, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) =>
    fit(
      createScrollbackWriter(() => <ReasoningEntry body={body} theme={theme} />, {
        width: cols(ctx),
        startOnNewLine: flags.startOnNewLine,
        trailingNewline: flags.trailingNewline,
      })(ctx),
      ctx,
      commit.gap,
    )
}

function blockTextWriter(body: string, theme: RunEntryTheme): ScrollbackWriter {
  return (ctx) =>
    full(() => <TextEntry body={body.endsWith("\n") ? body : `${body}\n`} fg={theme.system.body} />, ctx, {
      startOnNewLine: true,
      trailingNewline: false,
    })
}

function codeWriter(data: CodeInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <CodeTool theme={theme} data={data} />, ctx, flags)
}

function diffWriter(
  list: DiffInput[],
  theme: RunEntryTheme,
  flags: Flags,
  view: "unified" | "split",
): ScrollbackWriter {
  return (ctx) =>
    full(
      () => (
        <box flexDirection="column" gap={1}>
          <For each={list}>{(data) => <DiffTool theme={theme} data={data} view={view} />}</For>
        </box>
      ),
      ctx,
      flags,
    )
}

function taskWriter(data: TaskInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <TaskTool theme={theme} data={data} />, ctx, flags)
}

function todoWriter(data: TodoInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <TodoTool theme={theme} data={data} />, ctx, flags)
}

function questionWriter(data: QuestionInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <QuestionTool theme={theme} data={data} />, ctx, flags)
}

// ---------------------------------------------------------------------------
// Writer selection
// ---------------------------------------------------------------------------

function commitSpan(commit: StreamCommit): string {
  const time = (commit.part?.state as { time?: { start?: unknown; end?: unknown } } | undefined)?.time
  const start = num(time?.start)
  const end = num(time?.end)
  if (start === undefined || end === undefined || end <= start) {
    return ""
  }

  return Locale.duration(end - start)
}

function patchTitle(file: Record<string, unknown>) {
  const type = text(file.type)
  const rel = text(file.relativePath)
  const filePath = text(file.filePath)
  if (type === "add") {
    return `# Created ${rel || viewPath(filePath)}`
  }
  if (type === "delete") {
    return `# Deleted ${rel || viewPath(filePath)}`
  }
  if (type === "move") {
    return `# Moved ${viewPath(filePath)} -> ${rel || viewPath(text(file.movePath))}`
  }
  return `← Patched ${rel || viewPath(filePath)}`
}

function snapFlags(commit: StreamCommit) {
  if (commit.gap) {
    return {
      startOnNewLine: false,
      trailingNewline: true,
    }
  }

  if (commit.kind === "user") {
    return {
      startOnNewLine: true,
      trailingNewline: false,
    }
  }

  if (commit.kind === "tool") {
    if (commit.phase === "progress") {
      return {
        startOnNewLine: false,
        trailingNewline: false,
      }
    }

    return {
      startOnNewLine: true,
      trailingNewline: true,
    }
  }

  if (commit.kind === "assistant" || commit.kind === "reasoning") {
    if (commit.phase === "progress") {
      return {
        startOnNewLine: false,
        trailingNewline: false,
      }
    }

    return {
      startOnNewLine: true,
      trailingNewline: true,
    }
  }

  return {
    startOnNewLine: true,
    trailingNewline: true,
  }
}

function buildTextWriter(commit: StreamCommit, theme: RunEntryTheme): ScrollbackWriter {
  const body = normalizeEntry(commit)
  const flags = snapFlags(commit)

  if (commit.kind === "reasoning" && commit.phase === "progress" && !commit.gap) {
    return reasoningWriter(body, commit, theme, flags)
  }

  return textWriter(body, commit, theme, flags)
}

function buildCodeWriter(commit: StreamCommit, theme: RunEntryTheme): ScrollbackWriter {
  const info = toolCtx(commit, clean(commit.text))
  const file = text(info.data.filePath)
  const content = text(info.data.content)
  if (!file && !content) {
    return buildTextWriter(commit, theme)
  }

  return codeWriter(
    {
      title: `# Wrote ${viewPath(file)}`,
      content,
      filetype: toolFiletype(file),
      diagnostics: toolDiagnostics(info.meta, file),
    },
    theme,
    snapFlags(commit),
  )
}

function buildDiffWriter(commit: StreamCommit, theme: RunEntryTheme, opts: ScrollbackOptions): ScrollbackWriter {
  const info = toolCtx(commit, clean(commit.text))
  const flags = snapFlags(commit)

  if (commit.tool === "apply_patch") {
    const files = arr(info.meta.files).map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>) : {},
    )
    if (files.length === 0) {
      return buildTextWriter(commit, theme)
    }

    const list = files.map((file) => {
      const diff = text(file.diff)
      const name = text(file.movePath) || text(file.filePath) || text(file.relativePath)
      return {
        title: patchTitle(file),
        diff,
        filetype: toolFiletype(name),
        deletions: num(file.deletions) ?? 0,
        diagnostics: toolDiagnostics(info.meta, name),
      }
    })

    return (ctx) => diffWriter(list, theme, flags, toolDiffView(ctx.width, opts.diffStyle))(ctx)
  }

  const file = text(info.data.filePath)
  const diff = text(info.meta.diff)
  if (!file || !diff.trim()) {
    return buildTextWriter(commit, theme)
  }

  const list = [
    {
      title: `← Edit ${viewPath(file)}`,
      diff,
      filetype: toolFiletype(file),
      diagnostics: toolDiagnostics(info.meta, file),
    },
  ]

  return (ctx) => diffWriter(list, theme, flags, toolDiffView(ctx.width, opts.diffStyle))(ctx)
}

function buildStructuredWriter(commit: StreamCommit, theme: RunEntryTheme): ScrollbackWriter {
  const info = toolCtx(commit, clean(commit.text))
  const flags = snapFlags(commit)

  if (commit.tool === "task") {
    const kind = Locale.titlecase(text(info.data.subagent_type) || "general")
    const rows: string[] = []
    const desc = text(info.data.description)
    if (desc) {
      rows.push(`◉ ${desc}`)
    }
    const title = text(info.state.title)
    if (title) {
      rows.push(`↳ ${title}`)
    }
    const calls = num(info.meta.toolcalls) ?? num(info.meta.toolCalls) ?? num(info.meta.calls)
    if (calls !== undefined) {
      rows.push(`↳ ${Locale.number(calls)} toolcall${calls === 1 ? "" : "s"}`)
    }
    const sid = text(info.meta.sessionId) || text(info.meta.sessionID)
    if (sid) {
      rows.push(`↳ session ${sid}`)
    }

    return taskWriter(
      {
        title: `# ${kind} Task`,
        rows,
        tail: done(`${kind} task`, commitSpan(commit)),
      },
      theme,
      flags,
    )
  }

  if (commit.tool === "todowrite") {
    const items = arr(info.data.todos)
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : {}))
      .flatMap((item) => {
        const content = text(item.content)
        if (!content) {
          return []
        }

        return [
          {
            status: text(item.status),
            content,
          },
        ]
      })
    const doneN = items.filter((item) => item.status === "completed").length
    const runN = items.filter((item) => item.status === "in_progress").length
    const left = items.length - doneN - runN
    const tail = [`${items.length} total`]
    if (doneN > 0) {
      tail.push(`${doneN} done`)
    }
    if (runN > 0) {
      tail.push(`${runN} active`)
    }
    if (left > 0) {
      tail.push(`${left} pending`)
    }

    return todoWriter(
      {
        items,
        tail: `${done("todos", commitSpan(commit))} · ${tail.join(" · ")}`,
      },
      theme,
      flags,
    )
  }

  if (commit.tool === "question") {
    const answers = arr(info.meta.answers)
    const items = arr(info.data.questions)
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : {}))
      .map((item, i) => {
        const answer = arr(answers[i]).filter((entry): entry is string => typeof entry === "string")
        return {
          question: text(item.question) || `Question ${i + 1}`,
          answer: answer.length > 0 ? answer.join(", ") : "(no answer)",
        }
      })

    return questionWriter(
      {
        items,
        tail: done("questions", commitSpan(commit)),
      },
      theme,
      flags,
    )
  }

  return buildTextWriter(commit, theme)
}

export function normalizeEntry(commit: StreamCommit): string {
  const raw = clean(commit.text)
  const kind = commit.kind

  if (kind === "user") {
    if (!raw.trim()) {
      return ""
    }

    const lead = raw.match(/^\n+/)?.[0] ?? ""
    const body = lead ? raw.slice(lead.length) : raw
    return `${lead}› ${body}`
  }

  if (kind === "tool") {
    return formatToolEntry(commit, raw)
  }

  if (kind === "assistant") {
    if (commit.phase === "start") {
      return ""
    }

    if (commit.phase === "final") {
      return commit.interrupted ? "assistant interrupted" : ""
    }

    return raw
  }

  if (kind === "reasoning") {
    if (commit.phase === "start") {
      return ""
    }

    if (commit.phase === "final") {
      return commit.interrupted ? "reasoning interrupted" : ""
    }

    return raw.replace(/\[REDACTED\]/g, "")
  }

  if (commit.phase === "start" || commit.phase === "final") {
    return raw.trim()
  }

  if (kind === "error") {
    return raw
  }

  return raw
}

export function entryWriter(
  commit: StreamCommit,
  theme: RunEntryTheme = RUN_THEME_FALLBACK.entry,
  opts: ScrollbackOptions = {},
): ScrollbackWriter {
  const state = commit.toolState ?? commit.part?.state.status
  if (commit.kind === "tool" && commit.phase === "final" && state === "completed") {
    const view = toolView(commit.tool)

    if (view.snap === "code") {
      return buildCodeWriter(commit, theme)
    }

    if (view.snap === "diff") {
      return buildDiffWriter(commit, theme, opts)
    }

    if (view.snap === "structured") {
      return buildStructuredWriter(commit, theme)
    }
  }

  return buildTextWriter(commit, theme)
}

export function blockWriter(text: string, theme: RunEntryTheme = RUN_THEME_FALLBACK.entry): ScrollbackWriter {
  return blockTextWriter(clean(text), theme)
}
