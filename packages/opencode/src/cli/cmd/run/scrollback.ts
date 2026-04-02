import {
  TextAttributes,
  TextRenderable,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { StreamCommit } from "./types"

type Paint = {
  fg: ColorInput
  attributes?: number
}

let id = 0

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

export function normalizeEntry(commit: StreamCommit): string {
  const raw = commit.text.replace(/\r/g, "")
  const kind = commit.kind

  if (kind === "user") {
    if (!raw.trim()) {
      return ""
    }

    return `› ${raw}`
  }

  if (commit.phase === "start" || commit.phase === "final") {
    return raw.trim()
  }

  if (kind === "assistant") {
    // Preserve body formatting for progress
    return raw
  }

  if (kind === "reasoning") {
    const body = raw.replace(/\[REDACTED\]/g, "")
    // Keep reasoning raw unless we need special block formatting, but for now we preserve
    return body
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

  const startOnNewLine = commit.phase === "start" || commit.phase === "final" || commit.kind === "user"
  const trailingNewline = commit.phase === "start" || commit.phase === "final" || commit.kind === "user"

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

  return {
    root,
    width,
    height,
    rowColumns: width,
    startOnNewLine,
    trailingNewline,
  }
}

function normalizeBlock(text: string): string {
  return text.replace(/\r/g, "")
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
