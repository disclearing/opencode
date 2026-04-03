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
} from "@opentui/core"
import { Locale } from "../../../util/locale"
import { formatToolEntry, toolCtx, toolDiagnostics, toolDiffView, toolFiletype, viewPath } from "./scrollback-tools"
import type { RunEntryTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

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

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function next(name: string): string {
  return `run-direct-${name}-${ids++}`
}

function codeStyle() {
  syntax ??= SyntaxStyle.create()
  return syntax
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

function flags(commit: StreamCommit) {
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
  root: BoxRenderable | TextRenderable,
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
): ScrollbackSnapshot {
  const next = flags(commit)
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
    id: next("text"),
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
    id: next("frame"),
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
    id: next("shell"),
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

function span(commit: StreamCommit): string {
  const time = (commit.part?.state as { time?: { start?: unknown; end?: unknown } } | undefined)?.time
  const start = num(time?.start)
  const end = num(time?.end)
  if (start === undefined || end === undefined || end <= start) {
    return ""
  }

  return Locale.duration(end - start)
}

function done(name: string, time: string): string {
  if (!time) {
    return `└ ${name} completed`
  }

  return `└ ${name} completed · ${time}`
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
    id: next("entry"),
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
  const flag = flags(commit)

  return {
    root,
    width: commit.gap ? 0 : cols,
    height,
    rowColumns: cols,
    startOnNewLine: flag.startOnNewLine,
    trailingNewline: flag.trailingNewline,
  }
}

function fallback(commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunEntryTheme) {
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

function status(todo: Record<string, unknown>) {
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

export function buildTextSnapshot(
  body: string,
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
  theme: RunEntryTheme,
) {
  return textSnap(body, commit, ctx, theme)
}

export function buildBlockSnapshot(
  text: string,
  ctx: ScrollbackRenderContext,
  theme: RunEntryTheme,
): ScrollbackSnapshot {
  const body = clean(text)
  const root = new TextRenderable(ctx.renderContext, {
    id: next("block"),
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

export function buildCodeSnapshot(
  commit: StreamCommit,
  ctx: ScrollbackRenderContext,
  theme: RunEntryTheme,
): ScrollbackSnapshot {
  const info = toolCtx(commit, clean(commit.text))
  const file = text(info.data.filePath)
  const content = text(info.data.content)
  if (!file && !content) {
    return fallback(commit, ctx, theme)
  }

  const root = frame(ctx)
  const box = shell(ctx, theme, `# Wrote ${viewPath(file)}`)
  const line = new LineNumberRenderable(ctx.renderContext, {
    id: next("line"),
    width: "100%",
    height: "auto",
    fg: theme.system.body,
    minWidth: 3,
    paddingRight: 1,
  })
  const code = new CodeRenderable(ctx.renderContext, {
    id: next("code"),
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

export function buildDiffSnapshot(
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
      return fallback(commit, ctx, theme)
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
            id: next("diff"),
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
    return fallback(commit, ctx, theme)
  }

  const box = shell(ctx, theme, `← Edit ${viewPath(file)}`)
  box.add(
    new DiffRenderable(ctx.renderContext, {
      id: next("diff"),
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

export function buildStructuredSnapshot(
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
    box.add(row(ctx, done(`${kind} task`, span(commit)), theme.system.body, TextAttributes.DIM))
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
      box.add(row(ctx, `${status(todo)} ${content}`, theme.assistant.body))
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
    box.add(row(ctx, `${done("todos", span(commit))} · ${tail.join(" · ")}`, theme.system.body, TextAttributes.DIM))
    root.add(box)
    return snap(root, commit, ctx)
  }

  if (commit.tool === "question") {
    const box = shell(ctx, theme, "# Questions")
    box.add(row(ctx, done("questions", span(commit)), theme.system.body, TextAttributes.DIM))
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

  return fallback(commit, ctx, theme)
}
