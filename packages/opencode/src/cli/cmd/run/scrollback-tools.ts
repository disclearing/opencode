import path from "path"
import stripAnsi from "strip-ansi"
import { LANGUAGE_EXTENSIONS } from "../../../lsp/language"
import { Filesystem } from "../../../util/filesystem"
import { Locale } from "../../../util/locale"
import { toolView } from "./tool-policy"
import type { RunDiffStyle, StreamCommit } from "./types"

export type ToolDict = Record<string, unknown>

export type ToolCtx = {
  raw: string
  name: string
  data: ToolDict
  meta: ToolDict
  state: ToolDict
}

type Draw = (ctx: ToolCtx) => string
type Stage = StreamCommit["phase"]
type Spec = Partial<Record<Stage, Draw>>

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

export function viewPath(input: string): string {
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

export function toolDiagnostics(meta: ToolDict, file: string): string[] {
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

function done(name: string, time: string): string {
  if (!time) {
    return `└ ${name} completed`
  }

  return `└ ${name} completed · ${time}`
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

const map: Record<string, Spec> = {
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

export function toolCtx(commit: StreamCommit, raw: string): ToolCtx {
  const state = dict(commit.part?.state)
  return {
    raw,
    name: commit.tool || commit.part?.tool || "tool",
    data: dict(state.input),
    meta: dict(state.metadata),
    state,
  }
}

export function formatToolEntry(commit: StreamCommit, raw: string): string {
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

  const spec = map[ctx.name] ?? {}
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
