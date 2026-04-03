import path from "path"
import stripAnsi from "strip-ansi"
import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  LineNumberRenderable,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { LANGUAGE_EXTENSIONS } from "../../../lsp/language"
import { Filesystem } from "../../../util/filesystem"
import { Locale } from "../../../util/locale"
import { toolView } from "./stream"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { RunDiffStyle, ScrollbackOptions, StreamCommit } from "./types"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool formatting
// ---------------------------------------------------------------------------

type ToolCtx = {
  raw: string
  name: string
  data: ToolDict
  meta: ToolDict
  state: ToolDict
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

export function toolFiletype(input?: string): string | undefined {
  if (!input) {
    return
  }

  const ext = path.extname(input)
  const lang = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(lang)) {
    return "typescript"
  }

  return lang
}

export function toolDiffView(width: number, style: RunDiffStyle | undefined): "unified" | "split" {
  if (style === "stacked") {
    return "unified"
  }

  return width > 120 ? "split" : "unified"
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
  const state = text(ctx.state.error).trim()
  if (state) {
    return `✖ ${ctx.name} failed: ${state}`
  }

  const raw = ctx.raw.replace(/^\[tool:[^:\]]+:error\]\s*/, "").trim()
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
  const status = text(ctx.state.status)
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
  }
}

function formatToolEntry(commit: StreamCommit, raw: string): string {
  const ctx = toolCtx(commit, raw)
  const view = toolView(ctx.name)

  if (commit.phase === "progress" && !view.output) {
    return ""
  }

  if (commit.phase === "final") {
    const status = text(ctx.state.status)
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

type Paint = {
  fg: ColorInput
  attrs?: number
}

type Measure = {
  widthColsMax: number
}

type MeasureNode = {
  textBufferView?: {
    measureForDimensions(width: number, height: number): Measure | null
  }
}

let ids = 0
let syntax: SyntaxStyle | undefined

function nextId(name: string): string {
  return `run-direct-${name}-${ids++}`
}

function codeStyle() {
  syntax ??= SyntaxStyle.create()
  return syntax
}

function failed(commit: StreamCommit): boolean {
  return commit.kind === "tool" && commit.part?.state.status === "error"
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

function snap(
  root: BoxRenderable | TextRenderable | CodeRenderable,
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
): ScrollbackSnapshot {
  const next = snapFlags(commit)
  return {
    root,
    width: ctx.width,
    rowColumns: ctx.width,
    startOnNewLine: next.startOnNewLine,
    trailingNewline: next.trailingNewline,
  }
}

function row(
  ctx: ScrollbackRenderContext,
  text: string,
  fg: ColorInput,
  attrs?: number,
  width: number | `${number}%` = "100%",
) {
  return new TextRenderable(ctx.renderContext, {
    id: nextId("text"),
    width,
    height: "auto",
    content: text,
    wrapMode: "word",
    fg,
    attributes: attrs,
  })
}

function frame(ctx: ScrollbackRenderContext) {
  return new BoxRenderable(ctx.renderContext, {
    id: nextId("frame"),
    position: "absolute",
    left: 0,
    top: 0,
    width: ctx.width,
    height: "auto",
    flexDirection: "column",
    gap: 1,
  })
}

function shell(ctx: ScrollbackRenderContext, theme: RunEntryTheme, title: string) {
  const root = new BoxRenderable(ctx.renderContext, {
    id: nextId("shell"),
    width: "100%",
    height: "auto",
    flexDirection: "column",
    border: ["left"],
    borderColor: theme.system.body,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    gap: 1,
  })
  root.add(row(ctx, title, theme.system.body, TextAttributes.DIM))
  return root
}

function commitSpan(commit: StreamCommit): string {
  const time = (commit.part?.state as { time?: { start?: unknown; end?: unknown } } | undefined)?.time
  const start = num(time?.start)
  const end = num(time?.end)
  if (start === undefined || end === undefined || end <= start) {
    return ""
  }

  return Locale.duration(end - start)
}

function diags(root: BoxRenderable, ctx: ScrollbackRenderContext, theme: RunEntryTheme, rows: string[]) {
  for (const line of rows) {
    root.add(row(ctx, line, theme.error.body))
  }
}

function textSnap(
  body: string,
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
  theme: RunEntryTheme,
): ScrollbackSnapshot {
  const width = Math.max(1, ctx.width)
  const style = look(commit, theme)
  const root = new TextRenderable(ctx.renderContext, {
    id: nextId("entry"),
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: 1,
    content: body,
    wrapMode: "word",
    fg: style.fg,
    attributes: style.attrs,
  })
  const height = Math.max(1, root.scrollHeight)
  root.height = height
  const node = root as unknown as MeasureNode
  const box = node.textBufferView?.measureForDimensions(width, height)
  const cols = commit.gap ? 0 : Math.max(1, Math.min(width, box?.widthColsMax ?? 0))
  const flag = snapFlags(commit)

  return {
    root,
    width: commit.gap ? 0 : cols,
    height,
    rowColumns: cols,
    startOnNewLine: flag.startOnNewLine,
    trailingNewline: flag.trailingNewline,
  }
}

function reasoningSnap(body: string, commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunEntryTheme) {
  const width = Math.max(1, ctx.width)
  const root = new CodeRenderable(ctx.renderContext, {
    id: nextId("reasoning"),
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: 1,
    content: body,
    filetype: "markdown",
    syntaxStyle: codeStyle(),
    conceal: false,
    drawUnstyledText: false,
    streaming: true,
    wrapMode: "word",
    fg: theme.reasoning.body,
  })
  const height = Math.max(1, root.scrollHeight)
  root.height = height
  const node = root as unknown as MeasureNode
  const box = node.textBufferView?.measureForDimensions(width, height)
  const cols = commit.gap ? 0 : Math.max(1, Math.min(width, box?.widthColsMax ?? 0))
  const flag = snapFlags(commit)

  return {
    root,
    width: commit.gap ? 0 : cols,
    height,
    rowColumns: cols,
    startOnNewLine: flag.startOnNewLine,
    trailingNewline: flag.trailingNewline,
  }
}

function snapFallback(commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunEntryTheme) {
  return textSnap(formatToolEntry(commit, clean(commit.text)), commit, ctx, theme)
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

function todoStatus(todo: Record<string, unknown>) {
  const state = text(todo.status)
  if (state === "completed") {
    return "[x]"
  }
  if (state === "in_progress") {
    return "[>]"
  }
  if (state === "cancelled") {
    return "[-]"
  }
  return "[ ]"
}

function buildTextSnapshot(body: string, commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunEntryTheme) {
  if (commit.kind === "reasoning" && commit.phase === "progress" && !commit.gap) {
    return reasoningSnap(body, commit, ctx, theme)
  }

  return textSnap(body, commit, ctx, theme)
}

function buildBlockSnapshot(text: string, ctx: ScrollbackRenderContext, theme: RunEntryTheme): ScrollbackSnapshot {
  const body = clean(text)
  const root = new TextRenderable(ctx.renderContext, {
    id: nextId("block"),
    position: "absolute",
    left: 0,
    top: 0,
    width: ctx.width,
    height: 1,
    content: body.endsWith("\n") ? body : `${body}\n`,
    wrapMode: "word",
    fg: theme.system.body,
  })
  const height = Math.max(1, root.scrollHeight)
  root.height = height
  return {
    root,
    width: ctx.width,
    height,
    rowColumns: ctx.width,
    startOnNewLine: true,
    trailingNewline: false,
  }
}

function buildCodeSnapshot(
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
  theme: RunEntryTheme,
): ScrollbackSnapshot {
  const info = toolCtx(commit, clean(commit.text))
  const file = text(info.data.filePath)
  const content = text(info.data.content)
  if (!file && !content) {
    return snapFallback(commit, ctx, theme)
  }

  const root = frame(ctx)
  const box = shell(ctx, theme, `# Wrote ${viewPath(file)}`)
  const line = new LineNumberRenderable(ctx.renderContext, {
    id: nextId("line"),
    width: "100%",
    height: "auto",
    fg: theme.system.body,
    minWidth: 3,
    paddingRight: 1,
  })
  const code = new CodeRenderable(ctx.renderContext, {
    id: nextId("code"),
    width: "100%",
    height: "auto",
    content,
    filetype: toolFiletype(file),
    syntaxStyle: codeStyle(),
    conceal: false,
    drawUnstyledText: true,
    streaming: false,
    wrapMode: "word",
    fg: theme.assistant.body,
  })
  line.add(code)
  box.add(line)
  diags(box, ctx, theme, toolDiagnostics(info.meta, file))
  root.add(box)
  return snap(root, commit, ctx)
}

function buildDiffSnapshot(
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
  theme: RunEntryTheme,
  opts: ScrollbackOptions,
): ScrollbackSnapshot {
  const info = toolCtx(commit, clean(commit.text))
  const root = frame(ctx)

  if (commit.tool === "apply_patch") {
    const files = arr(info.meta.files).map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>) : {},
    )
    if (files.length === 0) {
      return snapFallback(commit, ctx, theme)
    }

    for (const file of files) {
      const box = shell(ctx, theme, patchTitle(file))
      const diff = text(file.diff)
      const name = text(file.movePath) || text(file.filePath) || text(file.relativePath)
      if (text(file.type) === "delete" || !diff.trim()) {
        const count = num(file.deletions) ?? 0
        box.add(row(ctx, `-${count} line${count === 1 ? "" : "s"}`, theme.error.body))
      } else {
        box.add(
          new DiffRenderable(ctx.renderContext, {
            id: nextId("diff"),
            width: "100%",
            height: "auto",
            diff,
            view: toolDiffView(ctx.width, opts.diffStyle),
            filetype: toolFiletype(name),
            syntaxStyle: codeStyle(),
            wrapMode: "word",
            showLineNumbers: true,
            fg: theme.assistant.body,
          }),
        )
      }
      diags(box, ctx, theme, toolDiagnostics(info.meta, name))
      root.add(box)
    }

    return snap(root, commit, ctx)
  }

  const file = text(info.data.filePath)
  const diff = text(info.meta.diff)
  if (!file || !diff.trim()) {
    return snapFallback(commit, ctx, theme)
  }

  const box = shell(ctx, theme, `← Edit ${viewPath(file)}`)
  box.add(
    new DiffRenderable(ctx.renderContext, {
      id: nextId("diff"),
      width: "100%",
      height: "auto",
      diff,
      view: toolDiffView(ctx.width, opts.diffStyle),
      filetype: toolFiletype(file),
      syntaxStyle: codeStyle(),
      wrapMode: "word",
      showLineNumbers: true,
      fg: theme.assistant.body,
    }),
  )
  diags(box, ctx, theme, toolDiagnostics(info.meta, file))
  root.add(box)
  return snap(root, commit, ctx)
}

function buildStructuredSnapshot(
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
  theme: RunEntryTheme,
): ScrollbackSnapshot {
  const info = toolCtx(commit, clean(commit.text))
  const root = frame(ctx)

  if (commit.tool === "task") {
    const kind = Locale.titlecase(text(info.data.subagent_type) || "general")
    const box = shell(ctx, theme, `# ${kind} Task`)
    const desc = text(info.data.description)
    if (desc) {
      box.add(row(ctx, `◉ ${desc}`, theme.assistant.body))
    }
    const title = text(info.state.title)
    if (title) {
      box.add(row(ctx, `↳ ${title}`, theme.assistant.body))
    }
    const calls = num(info.meta.toolcalls) ?? num(info.meta.toolCalls) ?? num(info.meta.calls)
    if (calls !== undefined) {
      box.add(row(ctx, `↳ ${Locale.number(calls)} toolcall${calls === 1 ? "" : "s"}`, theme.assistant.body))
    }
    const sid = text(info.meta.sessionId) || text(info.meta.sessionID)
    if (sid) {
      box.add(row(ctx, `↳ session ${sid}`, theme.assistant.body))
    }
    box.add(row(ctx, done(`${kind} task`, commitSpan(commit)), theme.system.body, TextAttributes.DIM))
    root.add(box)
    return snap(root, commit, ctx)
  }

  if (commit.tool === "todowrite") {
    const box = shell(ctx, theme, "# Todos")
    const todos = arr(info.data.todos).map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>) : {},
    )
    for (const todo of todos) {
      const content = text(todo.content)
      if (!content) {
        continue
      }
      box.add(row(ctx, `${todoStatus(todo)} ${content}`, theme.assistant.body))
    }
    const doneN = todos.filter((todo) => text(todo.status) === "completed").length
    const runN = todos.filter((todo) => text(todo.status) === "in_progress").length
    const left = todos.length - doneN - runN
    const tail = [`${todos.length} total`]
    if (doneN > 0) {
      tail.push(`${doneN} done`)
    }
    if (runN > 0) {
      tail.push(`${runN} active`)
    }
    if (left > 0) {
      tail.push(`${left} pending`)
    }
    box.add(
      row(ctx, `${done("todos", commitSpan(commit))} · ${tail.join(" · ")}`, theme.system.body, TextAttributes.DIM),
    )
    root.add(box)
    return snap(root, commit, ctx)
  }

  if (commit.tool === "question") {
    const box = shell(ctx, theme, "# Questions")
    box.add(row(ctx, done("questions", commitSpan(commit)), theme.system.body, TextAttributes.DIM))
    const questions = arr(info.data.questions).map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>) : {},
    )
    const answers = arr(info.meta.answers)
    for (const [i, item] of questions.entries()) {
      box.add(row(ctx, text(item.question) || `Question ${i + 1}`, theme.system.body))
      const answer = arr(answers[i]).filter((entry): entry is string => typeof entry === "string")
      box.add(row(ctx, answer.length > 0 ? answer.join(", ") : "(no answer)", theme.assistant.body))
    }
    root.add(box)
    return snap(root, commit, ctx)
  }

  return snapFallback(commit, ctx, theme)
}

// ---------------------------------------------------------------------------
// Entry dispatch
// ---------------------------------------------------------------------------

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
      return raw.trim() === "[assistant:interrupted]" ? "assistant interrupted" : ""
    }

    return raw
  }

  if (kind === "reasoning") {
    if (commit.phase === "start") {
      return ""
    }

    if (commit.phase === "final") {
      return raw.trim() === "[reasoning:interrupted]" ? "reasoning interrupted" : ""
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

function normalizeBlock(text: string): string {
  return clean(text)
}

function build(commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunEntryTheme, opts: ScrollbackOptions) {
  if (commit.kind === "tool" && commit.phase === "final" && commit.part?.state.status === "completed") {
    const view = toolView(commit.tool)

    if (view.snap === "code") {
      return buildCodeSnapshot(commit, ctx, theme)
    }

    if (view.snap === "diff") {
      return buildDiffSnapshot(commit, ctx, theme, opts)
    }

    if (view.snap === "structured") {
      return buildStructuredSnapshot(commit, ctx, theme)
    }
  }

  return buildTextSnapshot(normalizeEntry(commit), commit, ctx, theme)
}

export function entryWriter(
  commit: StreamCommit,
  theme: RunEntryTheme = RUN_THEME_FALLBACK.entry,
  opts: ScrollbackOptions = {},
): ScrollbackWriter {
  return (ctx) => build(commit, ctx, theme, opts)
}

export function blockWriter(text: string, theme: RunEntryTheme = RUN_THEME_FALLBACK.entry): ScrollbackWriter {
  return (ctx) => buildBlockSnapshot(normalizeBlock(text), ctx, theme)
}
