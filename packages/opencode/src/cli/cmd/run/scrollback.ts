import { type ScrollbackRenderContext, type ScrollbackWriter } from "@opentui/core"
import { formatToolEntry } from "./scrollback-tools"
import {
  buildBlockSnapshot,
  buildCodeSnapshot,
  buildDiffSnapshot,
  buildStructuredSnapshot,
  buildTextSnapshot,
} from "./scrollback.snapshot"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

function clean(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
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

function normalizeBlock(text: string): string {
  return clean(text)
}

function build(commit: StreamCommit, ctx: ScrollbackRenderContext, theme: RunEntryTheme, opts: ScrollbackOptions) {
  if (commit.kind === "tool" && commit.part?.state.status === "completed") {
    if (commit.phase === "final" && commit.tool === "write") {
      return buildCodeSnapshot(commit, ctx, theme)
    }

    if (commit.phase === "final" && (commit.tool === "edit" || commit.tool === "apply_patch")) {
      return buildDiffSnapshot(commit, ctx, theme, opts)
    }

    if (
      commit.phase === "final" &&
      (commit.tool === "task" || commit.tool === "todowrite" || commit.tool === "question")
    ) {
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
