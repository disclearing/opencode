/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { RunFooterView, hintFlags } from "../../../src/cli/cmd/run/footer.view"
import type { FooterState, FooterView, PermissionReply } from "../../../src/cli/cmd/run/types"

function get(node: any, id: string): any {
  if (node.id === id) {
    return node
  }

  if (typeof node.getChildren !== "function") {
    return
  }

  for (const child of node.getChildren()) {
    const found = get(child, id)
    if (found) {
      return found
    }
  }
}

function composer(setup: Awaited<ReturnType<typeof testRender>>) {
  const node = get(setup.renderer.root, "run-direct-footer-composer")
  if (!node) {
    throw new Error("composer not found")
  }

  return node as {
    plainText: string
    cursorOffset: number
  }
}

function permission(input: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "session-1",
    permission: "read",
    patterns: ["/tmp/file.txt"],
    metadata: {},
    always: [],
    ...input,
  }
}

function question(input: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "question-1",
    sessionID: "session-1",
    questions: [
      {
        question: "Streaming mode",
        header: "Mode",
        options: [{ label: "chunked", description: "Incremental output" }],
        multiple: false,
      },
    ],
    ...input,
  }
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  if (!setup) {
    return
  }

  setup.renderer.destroy()
  setup = undefined
})

describe("run footer view", () => {
  test("submit key path emits prompts", async () => {
    const sent: string[] = []
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: true,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={(text) => {
            sent.push(text)
            return true
          }}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={(text) => {
            setState((state) => ({
              ...state,
              status: text,
            }))
          }}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    await Promise.resolve()

    expect(sent).toEqual(["hello"])
  })

  test("failed submit restores text without recording history", async () => {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: true,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => false}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={(text) => {
            setState((state) => ({
              ...state,
              status: text,
            }))
          }}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    await Promise.resolve()

    const area = composer(setup) as any
    expect(area.plainText).toBe("hello")

    area.setText("")
    area.cursorOffset = 0
    setup.mockInput.pressArrow("up")
    expect(area.plainText).toBe("")
  })

  test("history up down keeps edge behavior", async () => {
    const sent: string[] = []
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: true,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={(text) => {
            sent.push(text)
            return true
          }}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={(text) => {
            setState((state) => ({
              ...state,
              status: text,
            }))
          }}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.mockInput.typeText("one")
    setup.mockInput.pressEnter()
    await setup.mockInput.typeText("two")
    setup.mockInput.pressEnter()
    await Promise.resolve()

    const area = composer(setup)

    setup.mockInput.pressArrow("up")
    expect(area.plainText).toBe("two")
    expect(area.cursorOffset).toBe(0)

    setup.mockInput.pressArrow("up")
    expect(area.plainText).toBe("one")
    expect(area.cursorOffset).toBe(0)

    setup.mockInput.pressArrow("up")
    expect(area.plainText).toBe("one")
    expect(area.cursorOffset).toBe(0)

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("one")
    expect(area.cursorOffset).toBe(area.plainText.length)

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("two")
    expect(area.cursorOffset).toBe(area.plainText.length)

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("")
    expect(area.cursorOffset).toBe(0)

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("")
    expect(area.cursorOffset).toBe(0)

    expect(sent).toEqual(["one", "two"])
  })

  test("history includes prior session prompts", async () => {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          history={["first", "second"]}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={(text) => {
            setState((state) => ({
              ...state,
              status: text,
            }))
          }}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    const area = composer(setup)

    setup.mockInput.pressArrow("up")
    expect(area.plainText).toBe("second")

    setup.mockInput.pressArrow("up")
    expect(area.plainText).toBe("first")

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("first")
    expect(area.cursorOffset).toBe(area.plainText.length)

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("second")
    expect(area.cursorOffset).toBe(area.plainText.length)

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("")
    expect(area.cursorOffset).toBe(0)
  })

  test("hint visibility matches width breakpoints", () => {
    expect(hintFlags(49)).toEqual({
      send: false,
      newline: false,
      history: false,
      variant: false,
    })

    expect(hintFlags(50)).toEqual({
      send: true,
      newline: false,
      history: false,
      variant: false,
    })

    expect(hintFlags(66)).toEqual({
      send: true,
      newline: true,
      history: false,
      variant: false,
    })

    expect(hintFlags(80)).toEqual({
      send: true,
      newline: true,
      history: true,
      variant: false,
    })

    expect(hintFlags(95)).toEqual({
      send: true,
      newline: true,
      history: true,
      variant: true,
    })
  })

  test("baseline scaffold follows 7-line layout", async () => {
    const [state] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "gpt-5.3-codex · openai",
      duration: "1m 18s",
      usage: "167.8K (42%)",
      first: true,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 120,
        height: 12,
      },
    )

    await setup.renderOnce()
    const lines = setup.captureCharFrame().split("\n")

    expect(lines[0]).toMatch(/^\s*$/)
    expect(lines[1]).toMatch(/^┃\s*$/)
    expect(lines[2]?.startsWith("┃")).toBe(true)
    expect(lines[2]).toContain('Ask anything... "Fix a TODO in the codebase"')
    expect(lines[3]).toMatch(/^┃\s*$/)
    expect(lines[4]?.startsWith("┃")).toBe(true)
    expect(lines[4]).toContain("Build")
    expect(lines[5]).toMatch(/^╹▀+$/)
    expect(lines[6]).not.toContain("interrupt")
    expect(lines[6]).toContain("▣  · 1m 18s")
    expect(lines[6]).toContain("167.8K (42%)")
    expect(lines[6]).toContain("ctrl+t variant")
  })

  test("renders usage and duration fields", async () => {
    const [state] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "1m 18s",
      usage: "167.8K (42%)",
      first: false,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 120,
        height: 12,
      },
    )

    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("▣  · 1m 18s")
    expect(frame).toContain("167.8K (42%)")
  })

  test("interrupt hint reflects running escape state", async () => {
    const [state] = createSignal<FooterState>({
      phase: "running",
      status: "assistant responding",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 1,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 120,
        height: 12,
      },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("esc again to interrupt")
  })

  test("duration marker hides when interrupt or exit hints are active", async () => {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "1m 18s",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 120,
        height: 12,
      },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("▣  · 1m 18s")

    setState((state) => ({
      ...state,
      phase: "running",
    }))
    await setup.renderOnce()
    const running = setup.captureCharFrame()
    expect(running).toContain("interrupt")
    expect(running).not.toContain("▣  · 1m 18s")

    setState((state) => ({
      ...state,
      phase: "idle",
      exit: 1,
    }))
    await setup.renderOnce()
    const exiting = setup.captureCharFrame()
    expect(exiting).toContain("Press Ctrl-c again to exit")
    expect(exiting).not.toContain("▣  · 1m 18s")
  })

  test("ctrl-c exit hint appears when armed", async () => {
    const [state] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 1,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 120,
        height: 12,
      },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Press Ctrl-c again to exit")
  })

  test("queued indicator appears when queue is nonzero", async () => {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: true,
      interrupt: 0,
      exit: 0,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("queued")

    setState((state) => ({
      ...state,
      queue: 2,
    }))

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("2 queued")
  })

  test("swaps prompt, question, and permission bodies", async () => {
    const [state] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })
    const [view, setView] = createSignal<FooterView>({ type: "prompt" })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          view={view}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.renderOnce()
    expect(get(setup.renderer.root, "run-direct-footer-composer")).toBeDefined()

    setView({
      type: "question",
      request: {
        id: "question-1",
        questions: [
          {
            question: "Streaming mode",
            header: "Mode",
            options: [{ label: "chunked", description: "Incremental output" }],
            multiple: false,
          },
        ],
      } as FooterView extends { type: "question"; request: infer R } ? R : never,
    })
    await setup.renderOnce()
    expect(get(setup.renderer.root, "run-direct-footer-composer")).toBeUndefined()
    expect(setup.captureCharFrame()).toContain("Questions pending")
    expect(setup.captureCharFrame()).toContain("1. Mode")

    setView({
      type: "permission",
      request: {
        id: "perm-1",
        permission: "read",
        patterns: ["/tmp/file.txt"],
        always: [],
        metadata: {},
      } as FooterView extends { type: "permission"; request: infer R } ? R : never,
    })
    await setup.renderOnce()
    expect(get(setup.renderer.root, "run-direct-footer-composer")).toBeUndefined()
    expect(setup.captureCharFrame()).toContain("Permission required")
    expect(setup.captureCharFrame()).toContain("Read /tmp/file.txt")

    setView({ type: "prompt" })
    await setup.renderOnce()
    expect(get(setup.renderer.root, "run-direct-footer-composer")).toBeDefined()
  })

  test("preserves prompt draft across permission and question views", async () => {
    const [state] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })
    const [view, setView] = createSignal<FooterView>({ type: "prompt" })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          view={view}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.mockInput.typeText("draft")
    setView({
      type: "permission",
      request: {
        id: "perm-1",
        permission: "read",
        patterns: ["/tmp/file.txt"],
        always: [],
        metadata: {},
      } as FooterView extends { type: "permission"; request: infer R } ? R : never,
    })
    await setup.renderOnce()

    setView({
      type: "question",
      request: {
        id: "question-1",
        questions: [
          {
            question: "Streaming mode",
            header: "Mode",
            options: [{ label: "chunked", description: "Incremental output" }],
            multiple: false,
          },
        ],
      } as FooterView extends { type: "question"; request: infer R } ? R : never,
    })
    await setup.renderOnce()

    setView({ type: "prompt" })
    await Promise.resolve()
    await setup.renderOnce()

    expect(composer(setup).plainText).toBe("draft")
  })

  test("non-prompt views own keyboard while ctrl-c stays global", async () => {
    const sent: string[] = []
    let cycles = 0
    let interrupts = 0
    let exits = 0
    const [state] = createSignal<FooterState>({
      phase: "running",
      status: "awaiting permission",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })
    const [view] = createSignal<FooterView>({
      type: "permission",
      request: {
        id: "perm-1",
        permission: "read",
        patterns: ["/tmp/file.txt"],
        always: [],
        metadata: {},
      } as FooterView extends { type: "permission"; request: infer R } ? R : never,
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          view={view}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={(text) => {
            sent.push(text)
            return true
          }}
          onCycle={() => {
            cycles += 1
          }}
          onInterrupt={() => {
            interrupts += 1
            return true
          }}
          onExitRequest={() => {
            exits += 1
            return true
          }}
          onExit={() => {
            exits += 1
          }}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    setup.mockInput.pressEscape()
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressKey("t", { ctrl: true })
    setup.mockInput.pressEnter()
    setup.mockInput.pressKey("c", { ctrl: true })
    await setup.renderOnce()

    expect(interrupts).toBe(0)
    expect(cycles).toBe(0)
    expect(sent).toEqual([])
    expect(exits).toBe(1)
  })

  test("permission body submits allow once and stays visible until event removal", async () => {
    const replies: PermissionReply[] = []
    const [state] = createSignal<FooterState>({
      phase: "running",
      status: "awaiting permission",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })
    const [view] = createSignal<FooterView>({
      type: "permission",
      request: permission(),
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          view={view}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onPermissionReply={async (input) => {
            replies.push(input)
          }}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.renderOnce()

    setup.mockInput.pressEnter()
    await Promise.resolve()
    await setup.renderOnce()

    expect(replies).toEqual([{ requestID: "perm-1", reply: "once" }])
    expect(get(setup.renderer.root, "run-direct-footer-permission-body")).toBeDefined()
  })

  test("permission body requires always confirmation before replying", async () => {
    const replies: PermissionReply[] = []
    const [state] = createSignal<FooterState>({
      phase: "running",
      status: "awaiting permission",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })
    const [view] = createSignal<FooterView>({
      type: "permission",
      request: permission({ always: ["*"] }),
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          view={view}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onPermissionReply={async (input) => {
            replies.push(input)
          }}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.renderOnce()

    setup.mockInput.pressArrow("right")
    setup.mockInput.pressEnter()
    await Promise.resolve()
    await setup.renderOnce()

    expect(replies).toEqual([])
    expect(setup.captureCharFrame()).toContain("Always allow")

    setup.mockInput.pressEnter()
    await Promise.resolve()
    await setup.renderOnce()

    expect(replies).toEqual([{ requestID: "perm-1", reply: "always" }])
  })

  test("permission reject stage captures feedback and submits reject reply", async () => {
    const replies: PermissionReply[] = []
    const [state] = createSignal<FooterState>({
      phase: "running",
      status: "awaiting permission",
      queue: 0,
      model: "model",
      duration: "",
      usage: "",
      first: false,
      interrupt: 0,
      exit: 0,
    })
    const [view] = createSignal<FooterView>({
      type: "permission",
      request: permission(),
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          view={view}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            interrupt: "escape",
            historyPrevious: "up",
            historyNext: "down",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Build"
          onSubmit={() => true}
          onPermissionReply={async (input) => {
            replies.push(input)
          }}
          onCycle={() => {}}
          onInterrupt={() => false}
          onExit={() => {}}
          onRows={() => {}}
          onStatus={() => {}}
        />
      ),
      {
        width: 110,
        height: 12,
      },
    )

    await setup.renderOnce()

    setup.mockInput.pressEscape()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Reject permission")

    await setup.mockInput.typeText("Please use ripgrep instead")
    setup.mockInput.pressEnter()
    await Promise.resolve()
    await setup.renderOnce()

    expect(replies).toEqual([
      {
        requestID: "perm-1",
        reply: "reject",
        message: "Please use ripgrep instead",
      },
    ])
  })
})
