import path from "path"
import {
  TextAttributes,
  TextRenderable,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import stripAnsi from "strip-ansi"
import { Locale } from "../../../util/locale"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { StreamCommit } from "./types"

type Paint = {
  fg: ColorInput
  attributes?: number
}

let id = 0

type Dict = Record<string, unknown>

type Measure = {
  widthColsMax: number
}

type MeasureNode = {
  textBufferView?: {
    measureForDimensions(width: number, height: number): Measure | null
  }
}

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function look(commit: StreamCommit, theme: RunEntryTheme): Paint {
  const kind = commit.kind
  if (kind === "user") {
    return {
      fg: theme.user.body,
      attributes: TextAttributes.BOLD,
    }
  }

  if (commit.phase === "final") {
    return {
      fg: theme.system.body,
      attributes: TextAttributes.DIM,
    }
  }

  if (kind === "assistant") {
    return {
      fg: theme.assistant.body,
    }
  }

  if (kind === "reasoning") {
    return {
      fg: theme.reasoning.body,
      attributes: TextAttributes.DIM,
    }
  }

  if (kind === "error") {
    return {
      fg: theme.error.body,
      attributes: TextAttributes.BOLD,
    }
  }

  if (kind === "tool") {
    return {
      fg: theme.tool.body,
    }
  }

  return {
    fg: theme.system.body,
  }
}

function dict(v: unknown): Dict {
  if (!v || typeof v !== "object") {
    return {}
  }

  return v as Dict
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

function view(pathLike: string): string {
  if (!pathLike) {
    return ""
  }

  const cwd = process.cwd()
  const abs = path.isAbsolute(pathLike) ? pathLike : path.resolve(cwd, pathLike)
  const rel = path.relative(cwd, abs)

  if (!rel) {
    return "."
  }

  if (!rel.startsWith("..")) {
    return rel
  }

  return abs
}

function details(data: Dict, skip: string[] = []): string {
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

function tool(commit: StreamCommit): string {
  return commit.tool || commit.part?.tool || "tool"
}

function input(commit: StreamCommit): Dict {
  return dict(commit.part?.state.input)
}

function meta(commit: StreamCommit): Dict {
  return dict(dict(commit.part?.state).metadata)
}

function state(commit: StreamCommit): Dict {
  return dict(commit.part?.state)
}

function span(commit: StreamCommit): string {
  const time = dict(state(commit).time)
  const start = num(time.start)
  const end = num(time.end)
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

function bashStart(data: Dict): string {
  const cmd = text(data.command)
  const desc = text(data.description) || "Shell"
  const wd = text(data.workdir)
  const dir = wd && wd !== "." ? view(wd) : ""
  const title = dir && !desc.includes(dir) ? `${desc} in ${dir}` : desc

  if (!cmd) {
    return `[tool:bash] ${title}`
  }

  return `[tool:bash] ${title}\n$ ${cmd}`
}

function readStart(data: Dict): string {
  const file = view(text(data.filePath))
  const extra = details(data, ["filePath"])
  return `[tool:read] Read ${file}${extra ? ` ${extra}` : ""}`.trim()
}

function writeStart(data: Dict): string {
  return `[tool:write] Write ${view(text(data.filePath))}`.trim()
}

function editStart(data: Dict): string {
  const flag = details({ replaceAll: data.replaceAll })
  return `[tool:edit] Edit ${view(text(data.filePath))}${flag ? ` ${flag}` : ""}`.trim()
}

function patchStart(commit: StreamCommit): string {
  const files = arr(meta(commit).files)
  if (files.length === 0) {
    return "[tool:apply_patch] Patch"
  }

  return `[tool:apply_patch] Patch ${files.length} file${files.length === 1 ? "" : "s"}`
}

function taskStart(data: Dict, raw: string): string {
  const desc = text(data.description)
  if (!desc) {
    return raw.trim()
  }

  const kind = Locale.titlecase(text(data.subagent_type) || "general")
  return `[tool:task] ${kind} Task - ${desc}`
}

function todoStart(data: Dict): string {
  const todos = arr(data.todos)
  if (todos.length === 0) {
    return "[tool:todowrite] Updating todos..."
  }

  return `[tool:todowrite] Updating ${todos.length} todo${todos.length === 1 ? "" : "s"}`
}

function questionStart(data: Dict): string {
  const count = arr(data.questions).length
  return `[tool:question] Asked ${count} question${count === 1 ? "" : "s"}`
}

function bashProgress(raw: string, data: Dict): string {
  const out = stripAnsi(raw)
  const cmd = text(data.command).trim()
  if (!cmd) {
    return out
  }

  const wdRaw = text(data.workdir).trim()
  const wd = wdRaw ? view(wdRaw) : ""
  const lines = out.split("\n")
  const first = (lines[0] || "").trim()
  const second = (lines[1] || "").trim()

  if (wd && (first === wd || first === wdRaw) && second === cmd) {
    const body = lines.slice(2).join("\n")
    return body.length > 0 ? body : out
  }

  if (first === cmd || first === `$ ${cmd}`) {
    const body = lines.slice(1).join("\n")
    return body.length > 0 ? body : out
  }

  if (wd && (first === `${wd} ${cmd}` || first === `${wdRaw} ${cmd}`)) {
    const body = lines.slice(1).join("\n")
    return body.length > 0 ? body : out
  }

  return out
}

function bashFinal(commit: StreamCommit): string {
  const code = num(meta(commit).exitCode) ?? num(meta(commit).exit_code)
  const time = span(commit)
  const head = code === undefined ? done("bash", time) : `└ bash completed (exit ${code})${time ? ` · ${time}` : ""}`
  return head
}

function readFinal(commit: StreamCommit): string {
  const list = arr(meta(commit).loaded).filter((v): v is string => typeof v === "string")
  const head = done("read", span(commit))
  if (list.length === 0) {
    return head
  }

  const lines = [head, ...list.slice(0, 5).map((item) => `↳ Loaded ${view(item)}`)]
  if (list.length > 5) {
    lines.push(`↳ ... and ${list.length - 5} more`)
  }

  return lines.join("\n")
}

function patchLine(v: Dict): string {
  const type = text(v.type)
  const rel = text(v.relativePath)
  const file = text(v.filePath)

  if (type === "add") {
    return `+ Created ${rel || view(file)}`
  }

  if (type === "delete") {
    return `- Deleted ${rel || view(file)}`
  }

  if (type === "move") {
    const from = view(file)
    const to = rel || view(text(v.movePath))
    return `→ Moved ${from} -> ${to}`
  }

  return `~ Patched ${rel || view(file)}`
}

function patchFinal(commit: StreamCommit): string {
  const files = arr(meta(commit).files).map(dict)
  const head = done("patch", span(commit))
  if (files.length === 0) {
    return head
  }

  const lines = [head, ...files.slice(0, 6).map(patchLine)]
  if (files.length > 6) {
    lines.push(`... and ${files.length - 6} more`)
  }

  return lines.join("\n")
}

function taskFinal(commit: StreamCommit): string {
  const data = input(commit)
  const kind = Locale.titlecase(text(data.subagent_type) || "general")
  const head = done(`${kind} task`, span(commit))
  const row: string[] = [head]

  const title = text(state(commit).title)
  if (title) {
    row.push(`↳ ${title}`)
  }

  const calls = num(meta(commit).toolcalls) ?? num(meta(commit).toolCalls) ?? num(meta(commit).calls)
  if (calls !== undefined) {
    row.push(`↳ ${Locale.number(calls)} toolcall${calls === 1 ? "" : "s"}`)
  }

  const sid = text(meta(commit).sessionId) || text(meta(commit).sessionID)
  if (sid) {
    row.push(`↳ session ${sid}`)
  }

  return row.join("\n")
}

function todoFinal(commit: StreamCommit): string {
  const list = arr(input(commit).todos).map(dict)
  if (list.length === 0) {
    return done("todos", span(commit))
  }

  const doneCount = list.filter((item) => text(item.status) === "completed").length
  const runCount = list.filter((item) => text(item.status) === "in_progress").length
  const left = list.length - doneCount - runCount
  const tail = [`${list.length} total`]
  if (doneCount > 0) {
    tail.push(`${doneCount} done`)
  }
  if (runCount > 0) {
    tail.push(`${runCount} active`)
  }
  if (left > 0) {
    tail.push(`${left} pending`)
  }

  return `${done("todos", span(commit))} · ${tail.join(" · ")}`
}

function questionFinal(commit: StreamCommit): string {
  const q = arr(input(commit).questions).map(dict)
  const a = arr(meta(commit).answers)
  if (q.length === 0) {
    return done("questions", span(commit))
  }

  const lines = [done("questions", span(commit))]
  for (const [i, item] of q.slice(0, 4).entries()) {
    const prompt = text(item.question)
    const reply = arr(a[i]).filter((v): v is string => typeof v === "string")
    lines.push(`? ${prompt || `Question ${i + 1}`}`)
    lines.push(`  ${reply.length > 0 ? reply.join(", ") : "(no answer)"}`)
  }

  if (q.length > 4) {
    lines.push(`... and ${q.length - 4} more`)
  }

  return lines.join("\n")
}

function final(commit: StreamCommit, raw: string): string {
  const name = tool(commit)
  const status = text(state(commit).status)
  if (status === "error") {
    return raw.trim()
  }

  if (status !== "completed") {
    return raw.trim()
  }

  if (name === "bash") {
    return bashFinal(commit)
  }

  if (name === "read") {
    return readFinal(commit)
  }

  if (name === "apply_patch") {
    return patchFinal(commit)
  }

  if (name === "task") {
    return taskFinal(commit)
  }

  if (name === "todowrite") {
    return todoFinal(commit)
  }

  if (name === "question") {
    return questionFinal(commit)
  }

  return done(name, span(commit))
}

// TODO: Copied/adopted from tui session tool renderers; evaluate shared layer later.
function formatToolEntry(commit: StreamCommit): string {
  const raw = clean(commit.text)

  if (commit.phase === "progress") {
    if (tool(commit) === "bash") {
      return bashProgress(raw, input(commit))
    }

    return raw
  }

  if (commit.phase === "final") {
    return final(commit, raw)
  }

  const data = input(commit)
  const name = tool(commit)

  if (name === "bash") {
    return bashStart(data)
  }

  if (name === "read") {
    return readStart(data)
  }

  if (name === "write") {
    return writeStart(data)
  }

  if (name === "edit") {
    return editStart(data)
  }

  if (name === "apply_patch") {
    return patchStart(commit)
  }

  if (name === "task") {
    return taskStart(data, raw)
  }

  if (name === "todowrite") {
    return todoStart(data)
  }

  if (name === "question") {
    return questionStart(data)
  }

  if (name === "skill") {
    return `[tool:skill] Skill "${text(data.name)}"`
  }

  const extra = details(data)
  return extra ? `[tool:${name}] ${extra}` : raw.trim()
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
    return formatToolEntry(commit)
  }

  if (kind === "assistant") {
    if (commit.phase === "start") {
      return ""
    }

    if (commit.phase === "final") {
      return raw.trim() === "[assistant:interrupted]" ? "assistant interrupted" : ""
    }

    // Preserve body formatting for progress
    return raw
  }

  if (kind === "reasoning") {
    if (commit.phase === "start") {
      return ""
    }

    if (commit.phase === "final") {
      return raw.trim() === "[reasoning:interrupted]" ? "reasoning interrupted" : ""
    }

    const body = raw.replace(/\[REDACTED\]/g, "")
    return body
  }

  if (commit.phase === "start" || commit.phase === "final") {
    return raw.trim()
  }

  if (kind === "error") {
    return raw
  }

  return raw
}

function build(commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunEntryTheme): ScrollbackSnapshot {
  const body = normalizeEntry(commit)
  const width = Math.max(1, ctx.width)
  const style = look(commit, theme)
  const gap = commit.gap === true

  const startOnNewLine = gap ? false : commit.phase === "start" || commit.phase === "final" || commit.kind === "user"
  const trailingNewline = gap ? true : (commit.phase === "start" || commit.phase === "final") && commit.kind !== "user"

  const root = new TextRenderable(ctx.renderContext, {
    id: `run-direct-entry-${id++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: 1,
    content: body,
    wrapMode: "word",
    fg: style.fg,
    attributes: style.attributes,
  })
  const height = Math.max(1, root.scrollHeight)
  root.height = height
  const node = root as unknown as MeasureNode
  const box = node.textBufferView?.measureForDimensions(width, height)
  const cols = Math.max(0, Math.min(width, box?.widthColsMax ?? 0))
  const snap = gap ? 0 : Math.max(1, cols)

  return {
    root,
    width: snap,
    height,
    rowColumns: cols,
    startOnNewLine,
    trailingNewline,
  }
}

function normalizeBlock(text: string): string {
  return clean(text)
}

function buildBlock(text: string, ctx: ScrollbackRenderContext, theme: RunEntryTheme): ScrollbackSnapshot {
  const body = normalizeBlock(text)
  const width = Math.max(1, ctx.width)
  const content = body.endsWith("\n") ? body : `${body}\n`
  const root = new TextRenderable(ctx.renderContext, {
    id: `run-direct-block-${id++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: 1,
    content,
    wrapMode: "word",
    fg: theme.system.body,
  })
  const height = Math.max(1, root.scrollHeight)
  root.height = height

  return {
    root,
    width,
    height,
    rowColumns: width,
    startOnNewLine: true,
    trailingNewline: false,
  }
}

export function entryWriter(commit: StreamCommit, theme: RunEntryTheme = RUN_THEME_FALLBACK.entry): ScrollbackWriter {
  return (ctx) => build(commit, ctx, theme)
}

export function blockWriter(text: string, theme: RunEntryTheme = RUN_THEME_FALLBACK.entry): ScrollbackWriter {
  return (ctx) => buildBlock(text, ctx, theme)
}
