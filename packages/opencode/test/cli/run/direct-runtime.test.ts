import { describe, expect, test } from "bun:test"
import { runPromptQueue } from "../../../src/cli/cmd/run/runtime"
import type { EntryKind, FooterApi, FooterPatch } from "../../../src/cli/cmd/run/types"

function createFooter() {
  const prompts = new Set<(text: string) => void>()
  const closes = new Set<() => void>()
  const patched: FooterPatch[] = []
  const appended: Array<{ kind: EntryKind; text: string }> = []
  let closed = false

  const close = () => {
    if (closed) {
      return
    }

    closed = true
    for (const fn of [...closes]) {
      fn()
    }
  }

  const footer: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt(fn) {
      prompts.add(fn)
      return () => {
        prompts.delete(fn)
      }
    },
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    patch(next) {
      patched.push(next)
    },
    append(kind, text) {
      appended.push({ kind, text })
    },
    close,
    destroy() {
      close()
      prompts.clear()
      closes.clear()
    },
  }

  return {
    footer,
    patched,
    appended,
    submit(text: string) {
      for (const fn of [...prompts]) {
        fn(text)
      }
    },
    close,
  }
}

describe("run runtime", () => {
  test("submit while running is queued", async () => {
    const ui = createFooter()
    const prompts: string[] = []
    let resume: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })

    const queue = runPromptQueue({
      footer: ui.footer,
      run: async (prompt) => {
        prompts.push(prompt)
        if (prompts.length === 1) {
          await gate
        }
      },
    })

    ui.submit("one")
    ui.submit("two")

    expect(prompts).toEqual(["one"])
    expect(ui.patched).toContainEqual({ queue: 1 })

    ui.close()
    resume?.()
    await queue
  })

  test("queued prompts run in order", async () => {
    const ui = createFooter()
    const prompts: string[] = []
    let resume: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    let done: (() => void) | undefined
    const seen = new Promise<void>((resolve) => {
      done = resolve
    })

    const queue = runPromptQueue({
      footer: ui.footer,
      run: async (prompt) => {
        prompts.push(prompt)
        if (prompts.length === 1) {
          await gate
          return
        }

        done?.()
      },
    })

    ui.submit("one")
    ui.submit("two")

    resume?.()
    await seen

    ui.close()
    await queue

    expect(prompts).toEqual(["one", "two"])
    expect(ui.appended).toEqual([
      { kind: "user", text: "one" },
      { kind: "user", text: "two" },
    ])
  })

  test("close stops pending queued work", async () => {
    const ui = createFooter()
    const prompts: string[] = []
    let resume: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })

    const queue = runPromptQueue({
      footer: ui.footer,
      run: async (prompt) => {
        prompts.push(prompt)
        if (prompts.length === 1) {
          await gate
        }
      },
    })

    ui.submit("one")
    ui.submit("two")

    ui.close()
    resume?.()
    await queue

    expect(prompts).toEqual(["one"])
    expect(ui.appended).toEqual([{ kind: "user", text: "one" }])
  })

  test("keeps initial input whitespace", async () => {
    const ui = createFooter()
    const prompts: string[] = []

    await runPromptQueue({
      footer: ui.footer,
      initialInput: "  hello  ",
      run: async (prompt) => {
        prompts.push(prompt)
        ui.close()
      },
    })

    expect(prompts).toEqual(["  hello  "])
    expect(ui.appended).toEqual([{ kind: "user", text: "  hello  " }])
  })

  test("propagates errors from prompt callbacks", async () => {
    const ui = createFooter()
    const queue = runPromptQueue({
      footer: ui.footer,
      run: async () => {
        throw new Error("boom")
      },
    })

    ui.submit("one")
    await expect(queue).rejects.toThrow("boom")
  })
})
