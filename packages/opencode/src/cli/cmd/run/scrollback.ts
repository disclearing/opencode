import {
  BoxRenderable,
  TextRenderable,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import type { EntryKind } from "./types"

type EntryStyle = {
  label: string
  border: string
  heading: string
  body: string
}

const MAX_ENTRY_WIDTH = 92

const ENTRY_STYLES: Record<EntryKind, EntryStyle> = {
  system: {
    label: "SYSTEM",
    border: "#64748b",
    heading: "#94a3b8",
    body: "#cbd5e1",
  },
  user: {
    label: "YOU",
    border: "#38bdf8",
    heading: "#7dd3fc",
    body: "#e0f2fe",
  },
  assistant: {
    label: "ASSISTANT",
    border: "#22d3ee",
    heading: "#67e8f9",
    body: "#f8fafc",
  },
  tool: {
    label: "TOOL",
    border: "#f59e0b",
    heading: "#fcd34d",
    body: "#fef3c7",
  },
  error: {
    label: "ERROR",
    border: "#ef4444",
    heading: "#fca5a5",
    body: "#fee2e2",
  },
}

let snapshotNodeCounter = 0

function lineColumns(line: string): number {
  return [...line].length
}

function blankRows(width: number, height: number): string {
  const row = " ".repeat(Math.max(1, width))
  return Array.from({ length: Math.max(1, height) }, () => row).join("\n")
}

function splitToken(token: string, width: number): string[] {
  const clampedWidth = Math.max(1, width)
  const chunks: string[] = []

  for (let offset = 0; offset < token.length; offset += clampedWidth) {
    chunks.push(token.slice(offset, offset + clampedWidth))
  }

  return chunks
}

function wrapText(text: string, width: number): string[] {
  const clampedWidth = Math.max(1, width)
  const paragraphs = text.replace(/\r/g, "").split("\n")
  const wrapped: string[] = []

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      wrapped.push("")
      continue
    }

    const words = paragraph.split(/\s+/)
    let current = ""

    for (const word of words) {
      if (!word) {
        continue
      }

      if (!current) {
        if (word.length <= clampedWidth) {
          current = word
        } else {
          const segments = splitToken(word, clampedWidth)
          current = segments.pop() ?? ""
          wrapped.push(...segments)
        }
        continue
      }

      const candidate = `${current} ${word}`
      if (candidate.length <= clampedWidth) {
        current = candidate
        continue
      }

      wrapped.push(current)

      if (word.length <= clampedWidth) {
        current = word
      } else {
        const segments = splitToken(word, clampedWidth)
        current = segments.pop() ?? ""
        wrapped.push(...segments)
      }
    }

    wrapped.push(current)
  }

  return wrapped.length > 0 ? wrapped : [""]
}

function truncateText(text: string, width: number): string {
  if (width <= 0) {
    return ""
  }

  const chars = [...text]
  if (chars.length <= width) {
    return text
  }

  if (width <= 3) {
    return chars.slice(0, width).join("")
  }

  return `${chars.slice(0, width - 3).join("")}...`
}

function formatTimestamp(timestamp: Date): string {
  const hh = timestamp.getHours().toString().padStart(2, "0")
  const mm = timestamp.getMinutes().toString().padStart(2, "0")
  const ss = timestamp.getSeconds().toString().padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

function buildSnapshot(
  kind: EntryKind,
  text: string,
  timestamp: Date,
  context: ScrollbackRenderContext,
): ScrollbackSnapshot {
  const style = ENTRY_STYLES[kind]
  const width = Math.max(3, context.width)
  const maxTextWidth = Math.max(18, Math.min(width - 3, MAX_ENTRY_WIDTH))
  const headingCore = truncateText(`${style.label} | ${formatTimestamp(timestamp)}`, maxTextWidth - 1)
  const headingLine = ` ${headingCore}`
  const bodyLines = wrapText(text, Math.max(1, maxTextWidth - 1)).map((line) => ` ${line}`)
  const longestBody = bodyLines.reduce((maxWidth, line) => Math.max(maxWidth, lineColumns(line)), 1)
  const longestLine = Math.max(lineColumns(headingLine), longestBody)

  const textWidth = Math.min(maxTextWidth, Math.max(2, longestLine + 1))
  const boxWidth = Math.min(width, Math.max(3, textWidth + 1))
  const boxHeight = Math.max(3, bodyLines.length + 1)

  const frame = new BoxRenderable(context.renderContext, {
    id: `run-direct-frame-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: boxHeight,
    border: false,
    backgroundColor: "transparent",
  })

  const clearFill = new TextRenderable(context.renderContext, {
    id: `run-direct-clear-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height: boxHeight,
    content: blankRows(width, boxHeight),
  })

  const box = new BoxRenderable(context.renderContext, {
    id: `run-direct-box-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width: boxWidth,
    height: boxHeight,
    border: ["left"],
    borderStyle: "single",
    borderColor: style.border,
    backgroundColor: "transparent",
  })

  const headingText = new TextRenderable(context.renderContext, {
    id: `run-direct-heading-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 1,
    top: 0,
    width: Math.max(1, boxWidth - 1),
    height: 1,
    content: headingLine,
    fg: style.heading,
    attributes: 1,
  })

  const bodyText = new TextRenderable(context.renderContext, {
    id: `run-direct-body-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 1,
    top: 1,
    width: Math.max(1, boxWidth - 1),
    height: Math.max(1, boxHeight - 1),
    content: bodyLines.join("\n"),
    fg: style.body,
  })

  box.add(headingText)
  box.add(bodyText)

  frame.add(clearFill)
  frame.add(box)

  return {
    root: frame,
    width,
    height: boxHeight,
    rowColumns: width,
    startOnNewLine: true,
    trailingNewline: true,
  }
}

export function entryWriter(kind: EntryKind, text: string, timestamp: Date = new Date()): ScrollbackWriter {
  return (context) => buildSnapshot(kind, text.replace(/\r/g, ""), timestamp, context)
}
