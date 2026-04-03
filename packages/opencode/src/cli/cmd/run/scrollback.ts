import {
  TextAttributes,
  TextRenderable,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { formatToolEntry } from "./scrollback-tools"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { StreamCommit } from "./types"

type Paint = {
  fg: ColorInput
  attributes?: number
}

type Measure = {
  widthColsMax: number
}

type MeasureNode = {
  textBufferView?: {
    measureForDimensions(width: number, height: number): Measure | null
  }
}

let id = 0

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function failed(commit: StreamCommit): boolean {
  if (commit.kind !== "tool") {
    return false
  }

  return commit.part?.state.status === "error"
}

function look(commit: StreamCommit, theme: RunEntryTheme): Paint {
  const kind = commit.kind
  if (kind === "user") {
    return {
      fg: theme.user.body,
      attributes: TextAttributes.BOLD,
    }
  }

  if (failed(commit)) {
    return {
      fg: theme.error.body,
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
