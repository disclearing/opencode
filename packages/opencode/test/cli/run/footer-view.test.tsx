/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { RunFooterView, hintFlags } from "../../../src/cli/cmd/run/footer.view"
import type { FooterState } from "../../../src/cli/cmd/run/types"

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
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Agent default"
          onSubmit={(text) => {
            sent.push(text)
            return true
          }}
          onCycle={() => {}}
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

    expect(sent).toEqual(["hello"])
  })

  test("history up down keeps edge behavior", async () => {
    const sent: string[] = []
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Agent default"
          onSubmit={(text) => {
            sent.push(text)
            return true
          }}
          onCycle={() => {}}
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

    area.cursorOffset = area.plainText.length
    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("two")
    expect(area.cursorOffset).toBe(area.plainText.length)

    area.cursorOffset = area.plainText.length
    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("")
    expect(area.cursorOffset).toBe(0)

    setup.mockInput.pressArrow("down")
    expect(area.plainText).toBe("")
    expect(area.cursorOffset).toBe(0)

    expect(sent).toEqual(["one", "two"])
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

  test("queued indicator appears when queue is nonzero", async () => {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: "model",
    })

    setup = await testRender(
      () => (
        <RunFooterView
          state={state}
          keybinds={{
            leader: "ctrl+x",
            variantCycle: "ctrl+t,<leader>t",
            inputSubmit: "return",
            inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
          }}
          agent="Agent default"
          onSubmit={() => true}
          onCycle={() => {}}
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
})
