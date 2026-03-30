import {
  TextAttributes,
  TextRenderable,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { EntryKind } from "./types"

type Paint = {
  fg: ColorInput
  attributes?: number
}

let id = 0

function look(kind: EntryKind, theme: RunEntryTheme): Paint {
  if (kind === "user") {
    return {
      fg: theme.user.body,
      attributes: TextAttributes.BOLD,
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

export function normalizeEntry(kind: EntryKind, text: string): string {
  const raw = text.replace(/\r/g, "")

  if (kind === "user") {
    if (!raw.trim()) {
      return ""
    }

    return `› ${raw}`
  }

  if (kind === "assistant") {
    return raw.trim()
  }

  if (kind === "reasoning") {
    const body = raw.replace(/\[REDACTED\]/g, "").trim()
    if (!body) {
      return ""
    }

    if (body.startsWith("Thinking:")) {
      return body
    }

    return `Thinking: ${body}`
  }

  if (kind === "error") {
    return raw.trim()
  }

  return raw.trim()
}

function build(kind: EntryKind, text: string, ctx: ScrollbackRenderContext, theme: RunEntryTheme): ScrollbackSnapshot {
  const body = normalizeEntry(kind, text)
  const width = Math.max(1, ctx.width)
  const style = look(kind, theme)
  const root = new TextRenderable(ctx.renderContext, {
    id: `run-direct-entry-${id++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: 1,
    content: `${body}\n`,
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
    startOnNewLine: true,
    trailingNewline: false,
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

export function entryWriter(
  kind: EntryKind,
  text: string,
  theme: RunEntryTheme = RUN_THEME_FALLBACK.entry,
): ScrollbackWriter {
  return (ctx) => build(kind, text, ctx, theme)
}

export function blockWriter(text: string, theme: RunEntryTheme = RUN_THEME_FALLBACK.entry): ScrollbackWriter {
  return (ctx) => buildBlock(text, ctx, theme)
}
