import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { blockWriter, entryWriter, normalizeEntry } from "../../../src/cli/cmd/run/scrollback"
import { RUN_THEME_FALLBACK } from "../../../src/cli/cmd/run/theme"
import type { ScrollbackOptions, StreamCommit } from "../../../src/cli/cmd/run/types"

function make(kind: StreamCommit["kind"], text: string, phase: StreamCommit["phase"] = "progress"): StreamCommit {
  return {
    kind,
    text,
    phase,
    source:
      kind === "assistant" ? "assistant" : kind === "reasoning" ? "reasoning" : kind === "tool" ? "tool" : "system",
  }
}

function makeTool(
  text: string,
  phase: StreamCommit["phase"],
  tool: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): StreamCommit {
  return {
    kind: "tool",
    text,
    phase,
    source: "tool",
    tool,
    part: {
      id: "tool-1",
      callID: "call-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "tool",
      tool,
      state: {
        status: "running",
        input: data,
        ...extra,
      },
    } as unknown as StreamCommit["part"],
  }
}

async function draw(commit: StreamCommit) {
  return drawWidth(commit, 80)
}

async function drawWidth(commit: StreamCommit, width: number, opts: ScrollbackOptions = {}) {
  const setup = await testRender(() => null, {
    width,
    height: 12,
  })

  try {
    const snap = entryWriter(
      commit,
      RUN_THEME_FALLBACK.entry,
      opts,
    )({
      width,
      widthMethod: setup.renderer.widthMethod,
      renderContext: (setup.renderer.root as any)._ctx,
    })
    const root = snap.root as any
    const nodes = walk(root)
    return {
      snap,
      root,
      nodes,
      textNodes: nodes.filter((node) => typeof node?.plainText === "string"),
      text: root.plainText as string,
      fg: root.fg,
      attrs: root.attributes ?? 0,
    }
  } finally {
    setup.renderer.destroy()
  }
}

async function drawBlock(text: string) {
  const setup = await testRender(() => null, {
    width: 80,
    height: 12,
  })

  try {
    const snap = blockWriter(
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

function walk(root: any): any[] {
  const list = [root]
  const children = typeof root?.getChildren === "function" ? root.getChildren() : []
  for (const child of children) {
    list.push(...walk(child))
  }
  return list
}

function same(a: unknown, b: unknown): boolean {
  if (a && typeof a === "object" && "equals" in a && typeof (a as any).equals === "function") {
    return (a as any).equals(b)
  }

  return a === b
}

describe("run scrollback", () => {
  test("renders progress entries inline by default", async () => {
    const out = await draw(make("assistant", "assistant reply"))

    expect(out.root.constructor.name).toBe("TextRenderable")
    expect(out.text).toBe("assistant reply")
    expect(out.text).not.toContain("ASSISTANT")
    expect(out.text).not.toMatch(/\b\d{2}:\d{2}:\d{2}\b/)
    expect(out.text).not.toMatch(/[│┃┆┇┊┋╹╻╺╸]/)
    expect(out.snap.width).toBe(15)
    expect(out.snap.rowColumns).toBe(15)
    expect(out.snap.startOnNewLine).toBe(false)
    expect(out.snap.trailingNewline).toBe(false)
  })

  test("hides assistant marker entries", () => {
    expect(normalizeEntry(make("assistant", "[assistant]", "start"))).toBe("")
    expect(normalizeEntry(make("assistant", "[assistant:end]", "final"))).toBe("")
    expect(normalizeEntry(make("assistant", "[assistant:interrupted]", "final"))).toBe("assistant interrupted")
  })

  test("adds user marker and keeps whitespace", async () => {
    const out = await draw(make("user", "  one  \r\n\t two\t\r\n", "start"))

    expect(out.text).toBe("›   one  \n\t two\t\n")
    expect(out.snap.width).toBe(9)
    expect(out.snap.rowColumns).toBe(9)
    expect(out.snap.startOnNewLine).toBe(true)
    expect(out.snap.trailingNewline).toBe(false)
  })

  test("renders spaced user follow-up prompt", () => {
    const out = normalizeEntry(make("user", "\nITS MISSING A SPACE", "start"))
    expect(out).toBe("\n› ITS MISSING A SPACE")
  })

  test("normalizes blank user input to empty", () => {
    expect(normalizeEntry(make("user", "   \r\n\t", "start"))).toBe("")
  })

  test("preserves assistant and error multiline content", async () => {
    const assistant = await draw(make("assistant", "\nfirst\nsecond\n"))
    expect(assistant.text).toBe("\nfirst\nsecond\n")
    expect(assistant.snap.startOnNewLine).toBe(false)
    expect(assistant.snap.trailingNewline).toBe(false)

    const error = await draw(make("error", "  failed\nwith detail  ", "start"))
    expect(error.text).toBe("failed\nwith detail")
    expect(error.snap.startOnNewLine).toBe(true)
    expect(error.snap.trailingNewline).toBe(true)
  })

  test("preserves whitespace-only progress chunks", async () => {
    const out = await draw(make("assistant", "   "))

    expect(out.text).toBe("   ")
    expect(out.snap.width).toBe(3)
    expect(out.snap.rowColumns).toBe(3)
    expect(out.snap.startOnNewLine).toBe(false)
    expect(out.snap.trailingNewline).toBe(false)
  })

  test("formats reasoning text with redaction cleanup", async () => {
    const out = await draw(make("reasoning", " [REDACTED]step\nnext "))
    expect(out.text).toBe(" step\nnext ")

    const prefixed = await draw(make("reasoning", "Thinking: keep\ngoing"))
    expect(prefixed.text).toBe("Thinking: keep\ngoing")
  })

  test("formats tool starts using adopted tui text", () => {
    const bash = normalizeEntry(
      makeTool("[tool:bash] running", "start", "bash", {
        description: "Run typecheck",
        command: "bun typecheck",
        workdir: "packages/opencode",
      }),
    )
    expect(bash).toContain("# Run typecheck in packages/opencode")
    expect(bash).toContain("$ bun typecheck")

    const task = normalizeEntry(
      makeTool("[tool:task] running", "start", "task", {
        subagent_type: "general",
        description: "investigate stream",
      }),
    )
    expect(task).toBe("│ General Task — investigate stream")

    const question = normalizeEntry(
      makeTool("[tool:question] running", "start", "question", {
        questions: [{ question: "Pick one", options: [{ label: "A", description: "a" }] }],
      }),
    )
    expect(question).toBe("→ Asked 1 question")

    const glob = normalizeEntry(
      makeTool("[tool:glob] running", "start", "glob", {
        pattern: "src/**/*.ts",
        path: "packages/opencode",
      }),
    )
    expect(glob).toBe('✱ Glob "src/**/*.ts" in packages/opencode')

    const skill = normalizeEntry(
      makeTool("[tool:skill] running", "start", "skill", {
        name: "opentui",
      }),
    )
    expect(skill).toBe('→ Skill "opentui"')
  })

  test("strips ansi from bash progress output", () => {
    const text = normalizeEntry(makeTool("\u001b[31merror\u001b[39m", "progress", "bash", {}))
    expect(text).toBe("error")
  })

  test("normalizes carriage returns in tool output", () => {
    const text = normalizeEntry(makeTool("cli/cmd\r./run.sh info session\r\nline-2", "progress", "bash", {}))
    expect(text).toBe("cli/cmd\n./run.sh info session\nline-2")
  })

  test("drops echoed bash invocation header from output", () => {
    const text = normalizeEntry(
      makeTool(
        "cli/cmd ./run.sh info session\nScript session info for 'session':\nRecorded: 11.1s, 20K",
        "progress",
        "bash",
        {
          workdir: "cli/cmd",
          command: "./run.sh info session",
        },
      ),
    )
    expect(text).toBe("Script session info for 'session':\nRecorded: 11.1s, 20K")
  })

  test("formats richer read and patch completion summaries", () => {
    const read = normalizeEntry(
      makeTool(
        "[tool:read:end]",
        "final",
        "read",
        {
          filePath: "/tmp/a.txt",
        },
        {
          status: "completed",
          metadata: {
            loaded: ["packages/opencode/src/index.ts", "README.md"],
          },
          time: { start: 0, end: 1500 },
        },
      ),
    )
    expect(read).toContain("└ read completed")
    expect(read).toContain("↳ Loaded packages/opencode/src/index.ts")

    const patch = normalizeEntry(
      makeTool(
        "[tool:apply_patch:end]",
        "final",
        "apply_patch",
        {},
        {
          status: "completed",
          metadata: {
            files: [
              { type: "add", relativePath: "src/new.ts", filePath: "src/new.ts" },
              { type: "delete", relativePath: "src/old.ts", filePath: "src/old.ts" },
            ],
          },
        },
      ),
    )
    expect(patch).toContain("└ patch completed")
    expect(patch).toContain("+ Created src/new.ts")
    expect(patch).toContain("- Deleted src/old.ts")
  })

  test("formats richer task, todo, and question completion summaries", () => {
    const task = normalizeEntry(
      makeTool(
        "[tool:task:end]",
        "final",
        "task",
        {
          subagent_type: "general",
          description: "investigate",
        },
        {
          status: "completed",
          title: "collecting logs",
          metadata: {
            toolCalls: 3,
            sessionId: "sess-123",
          },
          time: { start: 0, end: 1000 },
        },
      ),
    )
    expect(task).toContain("└ General task completed")
    expect(task).toContain("↳ collecting logs")
    expect(task).toContain("↳ 3 toolcalls")

    const todo = normalizeEntry(
      makeTool(
        "[tool:todowrite:end]",
        "final",
        "todowrite",
        {
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "in_progress" },
            { content: "c", status: "pending" },
          ],
        },
        {
          status: "completed",
        },
      ),
    )
    expect(todo).toContain("└ todos completed")
    expect(todo).toContain("3 total · 1 done · 1 active · 1 pending")

    const question = normalizeEntry(
      makeTool(
        "[tool:question:end]",
        "final",
        "question",
        {
          questions: [{ question: "Pick one", options: [{ label: "A", description: "a" }] }],
        },
        {
          status: "completed",
          metadata: {
            answers: [["A"]],
          },
        },
      ),
    )
    expect(question).toContain("└ questions completed")
    expect(question).toContain("? Pick one")
    expect(question).toContain("  A")
  })

  test("wraps long assistant lines without clipping content", async () => {
    const text =
      "The sky was a deep shade of indigo as the stars began to emerge. A gentle breeze rustled through the trees, carrying whispers of rain."
    const out = await draw(make("assistant", text))

    expect(out.text).toBe(text)
    expect(out.snap.height).toBeGreaterThan(1)
  })

  test("applies style mapping by entry phase and kind", async () => {
    const user = await draw(make("user", "u", "start"))
    const assistant = await draw(make("assistant", "a"))
    const reasoning = await draw(make("reasoning", "r"))
    const error = await draw(make("error", "e", "start"))
    const final = await draw(make("system", "[tool:end]", "final"))
    const terr = await draw(
      makeTool(
        "[tool:bash:error] boom",
        "final",
        "bash",
        {
          command: "ls",
        },
        {
          status: "error",
          error: "boom",
        },
      ),
    )

    expect(same(user.fg, RUN_THEME_FALLBACK.entry.user.body)).toBe(true)
    expect(Boolean(user.attrs & TextAttributes.BOLD)).toBe(true)

    expect(same(assistant.fg, RUN_THEME_FALLBACK.entry.assistant.body)).toBe(true)
    expect(Boolean(assistant.attrs & TextAttributes.BOLD)).toBe(false)

    expect(same(reasoning.fg, RUN_THEME_FALLBACK.entry.reasoning.body)).toBe(true)
    expect(Boolean(reasoning.attrs & TextAttributes.DIM)).toBe(true)

    expect(same(error.fg, RUN_THEME_FALLBACK.entry.error.body)).toBe(true)
    expect(Boolean(error.attrs & TextAttributes.BOLD)).toBe(true)

    expect(same(final.fg, RUN_THEME_FALLBACK.entry.system.body)).toBe(true)
    expect(Boolean(final.attrs & TextAttributes.DIM)).toBe(true)

    expect(terr.text).toBe("✖ bash failed: boom")
    expect(same(terr.fg, RUN_THEME_FALLBACK.entry.error.body)).toBe(true)
    expect(Boolean(terr.attrs & TextAttributes.BOLD)).toBe(true)
  })

  test("preserves multiline blocks with intentional spacing", async () => {
    const text = "+-------+\n| splash |\n+-------+\n\nSession   Demo"
    const out = await drawBlock(text)

    expect(out.text).toBe(`${text}\n`)
    expect(out.snap.width).toBe(80)
    expect(out.snap.rowColumns).toBe(80)
    expect(out.snap.startOnNewLine).toBe(true)
    expect(out.snap.trailingNewline).toBe(false)
  })

  test("keeps interior whitespace in preformatted blocks", async () => {
    const out = await drawBlock("Session   title\nContinue  opencode -s abc")
    expect(out.text).toContain("Session   title")
    expect(out.text).toContain("Continue  opencode -s abc")
  })

  test("tool start and final rows are standalone blocks", async () => {
    const start = await draw(
      makeTool("[tool:bash] running bash", "start", "bash", {
        command: "git status --short",
        description: "Shell command",
      }),
    )
    expect(start.snap.startOnNewLine).toBe(true)
    expect(start.snap.trailingNewline).toBe(true)

    const final = await draw(
      makeTool(
        "[tool:bash:end]",
        "final",
        "bash",
        {
          command: "git status --short",
        },
        {
          status: "completed",
          metadata: { exitCode: 0 },
        },
      ),
    )
    expect(final.snap.startOnNewLine).toBe(true)
    expect(final.snap.trailingNewline).toBe(true)
  })

  test("assistant progress rows stitch without extra newline", async () => {
    const out = await draw(make("assistant", "chunk"))
    expect(out.snap.startOnNewLine).toBe(false)
    expect(out.snap.trailingNewline).toBe(false)
  })

  test("gap commits create exactly one blank line before first streamed part", async () => {
    const out = await draw({
      kind: "assistant",
      text: "",
      phase: "progress",
      source: "assistant",
      partID: "part-1",
      gap: true,
    })

    expect(out.snap.startOnNewLine).toBe(false)
    expect(out.snap.trailingNewline).toBe(true)
    expect(out.snap.width).toBe(0)
  })

  test("write renders a code snapshot with inferred filetype and diagnostics tail", async () => {
    const out = await draw(
      makeTool(
        "[tool:write:end]",
        "final",
        "write",
        {
          filePath: "src/test.tsx",
          content: "export const x = 1\n",
        },
        {
          status: "completed",
          metadata: {
            diagnostics: {
              "src/test.tsx": [
                {
                  severity: 1,
                  message: "bad thing",
                  range: { start: { line: 1, character: 2 } },
                },
              ],
            },
          },
        },
      ),
    )

    expect(out.root.constructor.name).toBe("BoxRenderable")
    const code = out.nodes.find((node) => node.constructor.name === "CodeRenderable") as any
    expect(code).toBeDefined()
    expect(code.filetype).toBe("typescript")
    expect(code.content).toBe("export const x = 1\n")
    expect(out.textNodes.some((node) => node.plainText === "Error [2:3] bad thing")).toBe(true)
  })

  test("edit renders a diff snapshot using the width-based view rule", async () => {
    const narrow = await drawWidth(
      makeTool(
        "[tool:edit:end]",
        "final",
        "edit",
        {
          filePath: "src/test.ts",
        },
        {
          status: "completed",
          metadata: {
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        },
      ),
      80,
    )
    const wide = await drawWidth(
      makeTool(
        "[tool:edit:end]",
        "final",
        "edit",
        {
          filePath: "src/test.ts",
        },
        {
          status: "completed",
          metadata: {
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        },
      ),
      140,
    )

    const a = narrow.nodes.find((node) => node.constructor.name === "DiffRenderable") as any
    const b = wide.nodes.find((node) => node.constructor.name === "DiffRenderable") as any
    expect(a.view).toBe("unified")
    expect(b.view).toBe("split")
  })

  test("stacked diff preference forces unified direct snapshots", async () => {
    const out = await drawWidth(
      makeTool(
        "[tool:edit:end]",
        "final",
        "edit",
        {
          filePath: "src/test.ts",
        },
        {
          status: "completed",
          metadata: {
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        },
      ),
      140,
      { diffStyle: "stacked" },
    )

    const diff = out.nodes.find((node) => node.constructor.name === "DiffRenderable") as any
    expect(diff.view).toBe("unified")
  })

  test("apply_patch renders one stable block per touched file with fullscreen titles", async () => {
    const out = await draw(
      makeTool(
        "[tool:apply_patch:end]",
        "final",
        "apply_patch",
        {},
        {
          status: "completed",
          metadata: {
            files: [
              {
                type: "add",
                relativePath: "src/new.ts",
                filePath: "src/new.ts",
                diff: "@@ -0,0 +1 @@\n+export const x = 1\n",
              },
              {
                type: "delete",
                relativePath: "src/old.ts",
                filePath: "src/old.ts",
                deletions: 3,
              },
            ],
          },
        },
      ),
    )

    expect(out.textNodes.some((node) => node.plainText === "# Created src/new.ts")).toBe(true)
    expect(out.textNodes.some((node) => node.plainText === "# Deleted src/old.ts")).toBe(true)
    expect(out.textNodes.some((node) => node.plainText === "-3 lines")).toBe(true)
    expect(out.nodes.filter((node) => node.constructor.name === "DiffRenderable")).toHaveLength(1)
  })

  test("task, todowrite, and question render grouped structured snapshots", async () => {
    const task = await draw(
      makeTool(
        "[tool:task:end]",
        "final",
        "task",
        {
          subagent_type: "general",
          description: "investigate stream",
        },
        {
          status: "completed",
          title: "collecting logs",
          metadata: {
            toolCalls: 3,
            sessionId: "sess-123",
          },
          time: { start: 0, end: 1000 },
        },
      ),
    )
    expect(task.root.constructor.name).toBe("BoxRenderable")
    expect(task.textNodes.some((node) => node.plainText === "# General Task")).toBe(true)
    expect(task.textNodes.some((node) => node.plainText === "◉ investigate stream")).toBe(true)
    expect(task.textNodes.some((node) => node.plainText === "↳ collecting logs")).toBe(true)

    const todo = await draw(
      makeTool(
        "[tool:todowrite:end]",
        "final",
        "todowrite",
        {
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "in_progress" },
          ],
        },
        {
          status: "completed",
        },
      ),
    )
    expect(todo.root.constructor.name).toBe("BoxRenderable")
    expect(todo.textNodes.some((node) => node.plainText === "# Todos")).toBe(true)
    expect(todo.textNodes.some((node) => node.plainText === "[x] a")).toBe(true)
    expect(todo.textNodes.some((node) => node.plainText === "[>] b")).toBe(true)

    const question = await draw(
      makeTool(
        "[tool:question:end]",
        "final",
        "question",
        {
          questions: [{ question: "Pick one", options: [{ label: "A", description: "a" }] }],
        },
        {
          status: "completed",
          metadata: {
            answers: [["A"]],
          },
        },
      ),
    )
    expect(question.root.constructor.name).toBe("BoxRenderable")
    expect(question.textNodes.some((node) => node.plainText === "# Questions")).toBe(true)
    expect(question.textNodes.some((node) => node.plainText === "Pick one")).toBe(true)
    expect(question.textNodes.some((node) => node.plainText === "A")).toBe(true)
  })

  test("unknown file extensions keep filetype undefined", async () => {
    const out = await draw(
      makeTool(
        "[tool:write:end]",
        "final",
        "write",
        {
          filePath: "src/test.unknownext",
          content: "plain text\n",
        },
        {
          status: "completed",
          metadata: {},
        },
      ),
    )

    const code = out.nodes.find((node) => node.constructor.name === "CodeRenderable") as any
    expect(code.filetype).toBeUndefined()
  })
})
