import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import {
  SPLASH_TITLE_FALLBACK,
  SPLASH_TITLE_LIMIT,
  entrySplash,
  exitSplash,
  splashMeta,
} from "../../../src/cli/cmd/run/splash"
import { RUN_THEME_FALLBACK } from "../../../src/cli/cmd/run/theme"

async function draw(write: ReturnType<typeof entrySplash>) {
  const setup = await testRender(() => null, {
    width: 100,
    height: 24,
  })

  try {
    const snap = write({
      width: 100,
      widthMethod: setup.renderer.widthMethod,
      renderContext: (setup.renderer.root as any)._ctx,
    })
    const root = snap.root as any
    const children = root.getChildren() as any[]
    const rows = new Map<number, string[]>()

    for (const child of children) {
      if (typeof child.left !== "number" || typeof child.top !== "number") {
        continue
      }

      if (typeof child.plainText !== "string" || child.plainText.length === 0) {
        continue
      }

      const row = rows.get(child.top) ?? []
      for (let i = 0; i < child.plainText.length; i += 1) {
        row[child.left + i] = child.plainText[i]
      }
      rows.set(child.top, row)
    }

    const lines = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.join("").replace(/\s+$/g, ""))

    return {
      snap,
      lines,
      children,
    }
  } finally {
    setup.renderer.destroy()
  }
}

describe("run splash", () => {
  test("builds entry text with logo", () => {
    const text = entrySplash({
      title: "Demo",
      session_id: "sess-1",
      theme: RUN_THEME_FALLBACK.entry,
      background: RUN_THEME_FALLBACK.background,
    })

    return draw(text).then((out) => {
      expect(out.lines.some((line) => line.includes("█▀▀█"))).toBe(true)
      expect(out.lines.join("\n")).toContain("Session   Demo")
      expect(out.lines.join("\n")).toContain("Type /exit or /quit to finish.")
      expect(out.children.some((item) => item.plainText === " " && item.bg && item.bg.a > 0)).toBe(true)
      expect(out.snap.height).toBeGreaterThan(5)
      expect(out.snap.startOnNewLine).toBe(true)
      expect(out.snap.trailingNewline).toBe(false)
    })
  })

  test("builds exit text with aligned rows", () => {
    const text = exitSplash({
      title: "Demo",
      session_id: "sess-1",
      theme: RUN_THEME_FALLBACK.entry,
      background: RUN_THEME_FALLBACK.background,
    })

    return draw(text).then((out) => {
      expect(out.lines.join("\n")).toContain("Session   Demo")
      expect(out.lines.join("\n")).toContain("Continue  opencode -s sess-1")
      expect(out.snap.height).toBeGreaterThan(5)
    })
  })

  test("applies stable fallback title", () => {
    expect(
      splashMeta({
        title: undefined,
        session_id: "sess-1",
      }).title,
    ).toBe(SPLASH_TITLE_FALLBACK)

    expect(
      splashMeta({
        title: "   ",
        session_id: "sess-1",
      }).title,
    ).toBe(SPLASH_TITLE_FALLBACK)
  })

  test("truncates title with tui cap", () => {
    const meta = splashMeta({
      title: "x".repeat(80),
      session_id: "sess-1",
    })

    expect(meta.title.length).toBeLessThanOrEqual(SPLASH_TITLE_LIMIT)
    expect(meta.title.endsWith("…")).toBe(true)
  })
})
