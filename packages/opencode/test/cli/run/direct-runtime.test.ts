import { describe, expect, test } from "bun:test"
import { queueSplash, runPromptQueue } from "../../../src/cli/cmd/run/runtime"
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
    listeners() {
      return {
        prompts: prompts.size,
        closes: closes.size,
      }
    },
    submit(text: string) {
      for (const fn of [...prompts]) {
        fn(text)
      }
    },
    close,
  }
}

describe("run runtime", () => {
  test("queues entry and exit splash only once", () => {
    const writes: unknown[] = []
    let renders = 0
    const renderer = {
      writeToScrollback(write: unknown) {
        writes.push(write)
      },
      requestRender() {
        renders += 1
      },
    } as any

    const state = {
      entry: false,
      exit: false,
    }

    const write = () => ({}) as any

    expect(queueSplash(renderer, state, "entry", write)).toBe(true)
    expect(queueSplash(renderer, state, "entry", write)).toBe(false)
    expect(queueSplash(renderer, state, "exit", write)).toBe(true)
    expect(queueSplash(renderer, state, "exit", write)).toBe(false)

    expect(writes).toHaveLength(2)
    expect(renders).toBe(2)
  })

  test("returns immediately when footer is already closed", async () => {
    const ui = createFooter()
    let calls = 0
    ui.close()

    await runPromptQueue({
      footer: ui.footer,
      run: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(0)
    expect(ui.listeners()).toEqual({ prompts: 0, closes: 0 })
  })

  test("close resolves queue and unsubscribes listeners", async () => {
    const ui = createFooter()

    const queue = runPromptQueue({
      footer: ui.footer,
      run: async () => {},
    })

    expect(ui.listeners()).toEqual({ prompts: 1, closes: 1 })

    ui.close()
    await queue

    expect(ui.listeners()).toEqual({ prompts: 0, closes: 0 })
  })

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
    expect(ui.patched).toContainEqual({
      phase: "idle",
      status: "",
      queue: 0,
    })
  })

  test("close aborts active run signal", async () => {
    const ui = createFooter()
    let hit = false

    const queue = runPromptQueue({
      footer: ui.footer,
      run: async (_, signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            hit = true
            resolve()
            return
          }

          signal.addEventListener(
            "abort",
            () => {
              hit = true
              resolve()
            },
            { once: true },
          )
        })
      },
    })

    ui.submit("one")
    ui.close()
    await queue

    expect(hit).toBe(true)
  })

  test("close resolves even when run ignores abort", async () => {
    const ui = createFooter()

    const queue = runPromptQueue({
      footer: ui.footer,
      run: async () => {
        await new Promise<void>(() => {})
      },
    })

    ui.submit("one")
    ui.close()

    const result = await Promise.race([
      queue.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ])

    expect(result).toBe("done")
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

  test("records last turn duration", async () => {
    const ui = createFooter()

    await runPromptQueue({
      footer: ui.footer,
      initialInput: "one",
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        ui.close()
      },
    })

    const duration = ui.patched.find((item) => typeof item.duration === "string")?.duration
    expect(typeof duration).toBe("string")
    expect(duration?.length ?? 0).toBeGreaterThan(0)
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
