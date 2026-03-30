import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { entryWriter, normalizeEntry } from "../../../src/cli/cmd/run/scrollback"
import { RUN_THEME_FALLBACK } from "../../../src/cli/cmd/run/theme"
import type { EntryKind } from "../../../src/cli/cmd/run/types"

async function draw(kind: EntryKind, text: string) {
  const setup = await testRender(() => null, {
    width: 80,
    height: 12,
  })

  try {
    const snap = entryWriter(
      kind,
      text,
      RUN_THEME_FALLBACK.entry,
    )({
      width: 80,
      widthMethod: setup.renderer.widthMethod,
      renderContext: (setup.renderer.root as any)._ctx,
    })
    const root = snap.root as any
    return {
      snap,
      root,
      text: root.plainText as string,
      fg: root.fg,
      attrs: root.attributes ?? 0,
    }
  } finally {
    setup.renderer.destroy()
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a && typeof a === "object" && "equals" in a && typeof (a as any).equals === "function") {
    return (a as any).equals(b)
  }

  return a === b
}

describe("run scrollback", () => {
  test("renders plain entries with one blank separator", async () => {
    const out = await draw("assistant", "assistant reply")

    expect(out.root.constructor.name).toBe("TextRenderable")
    expect(out.text).toBe("assistant reply\n")
    expect(out.text).not.toContain("ASSISTANT")
    expect(out.text).not.toMatch(/\b\d{2}:\d{2}:\d{2}\b/)
    expect(out.text).not.toMatch(/[│┃┆┇┊┋╹╻╺╸]/)
    expect(out.text.split("\n")[0]).toBe("assistant reply")
    expect(out.snap.width).toBe(80)
    expect(out.snap.rowColumns).toBe(80)
    expect(out.snap.startOnNewLine).toBe(true)
    expect(out.snap.trailingNewline).toBe(false)
  })

  test("adds user marker and keeps whitespace", async () => {
    const out = await draw("user", "  one  \r\n\t two\t\r\n")
    expect(out.text).toBe("›   one  \n\t two\t\n\n")
  })

  test("normalizes blank user input to empty", () => {
    expect(normalizeEntry("user", "   \r\n\t")).toBe("")
  })

  test("preserves assistant and error multiline content", async () => {
    const assistant = await draw("assistant", "\nfirst\nsecond\n")
    expect(assistant.text).toBe("first\nsecond\n")

    const error = await draw("error", "  failed\nwith detail  ")
    expect(error.text).toBe("failed\nwith detail\n")
  })

  test("formats reasoning text with redaction cleanup", async () => {
    const out = await draw("reasoning", " [REDACTED]step\nnext ")
    expect(out.text).toBe("Thinking: step\nnext\n")

    const prefixed = await draw("reasoning", "Thinking: keep\ngoing")
    expect(prefixed.text).toBe("Thinking: keep\ngoing\n")
  })

  test("wraps long assistant lines without clipping content", async () => {
    const text =
      "The sky was a deep shade of indigo as the stars began to emerge. A gentle breeze rustled through the trees, carrying whispers of rain."
    const out = await draw("assistant", text)

    expect(out.text).toBe(`${text}\n`)
    expect(out.snap.height).toBeGreaterThan(2)
  })

  test("applies style mapping by entry kind", async () => {
    const user = await draw("user", "u")
    const assistant = await draw("assistant", "a")
    const reasoning = await draw("reasoning", "r")
    const error = await draw("error", "e")

    expect(same(user.fg, RUN_THEME_FALLBACK.entry.user.body)).toBe(true)
    expect(Boolean(user.attrs & TextAttributes.BOLD)).toBe(true)

    expect(same(assistant.fg, RUN_THEME_FALLBACK.entry.assistant.body)).toBe(true)
    expect(Boolean(assistant.attrs & TextAttributes.BOLD)).toBe(false)

    expect(same(reasoning.fg, RUN_THEME_FALLBACK.entry.reasoning.body)).toBe(true)
    expect(Boolean(reasoning.attrs & TextAttributes.DIM)).toBe(true)

    expect(same(error.fg, RUN_THEME_FALLBACK.entry.error.body)).toBe(true)
    expect(Boolean(error.attrs & TextAttributes.BOLD)).toBe(true)
  })
})
