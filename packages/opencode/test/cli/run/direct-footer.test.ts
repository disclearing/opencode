import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RunFooter } from "../../../src/cli/cmd/run/footer"
import { RUN_THEME_FALLBACK } from "../../../src/cli/cmd/run/theme"

async function create() {
  const setup = await testRender(() => null, {
    width: 100,
    height: 20,
  })

  setup.renderer.screenMode = "split-footer"
  setup.renderer.footerHeight = 6

  let interrupts = 0
  let exits = 0

  const footer = new RunFooter(setup.renderer as any, {
    agentLabel: "Build",
    modelLabel: "Model default",
    first: false,
    theme: RUN_THEME_FALLBACK,
    keybinds: {
      leader: "ctrl+x",
      variantCycle: "ctrl+t,<leader>t",
      interrupt: "escape",
      historyPrevious: "up",
      historyNext: "down",
      inputSubmit: "return",
      inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
    },
    onInterrupt: () => {
      interrupts += 1
    },
    onExit: () => {
      exits += 1
    },
  })

  return {
    setup,
    footer,
    interrupts: () => interrupts,
    exits: () => exits,
    destroy() {
      footer.destroy()
      setup.renderer.destroy()
    },
  }
}

describe("run footer", () => {
  test("interrupt requires running phase", async () => {
    const ctx = await create()

    try {
      expect((ctx.footer as any).handleInterrupt()).toBe(false)
      expect(ctx.interrupts()).toBe(0)
    } finally {
      ctx.destroy()
    }
  })

  test("double interrupt triggers callback once", async () => {
    const ctx = await create()

    try {
      ctx.footer.patch({ phase: "running" })

      expect((ctx.footer as any).handleInterrupt()).toBe(true)
      expect((ctx.footer as any).state().interrupt).toBe(1)
      expect((ctx.footer as any).state().status).toBe("esc again to interrupt")
      expect(ctx.interrupts()).toBe(0)

      expect((ctx.footer as any).handleInterrupt()).toBe(true)
      expect((ctx.footer as any).state().interrupt).toBe(0)
      expect((ctx.footer as any).state().status).toBe("interrupting")
      expect(ctx.interrupts()).toBe(1)
    } finally {
      ctx.destroy()
    }
  })

  test("double exit closes and calls onExit once", async () => {
    const ctx = await create()

    try {
      expect(ctx.footer.requestExit()).toBe(true)
      expect(ctx.footer.isClosed).toBe(false)
      expect((ctx.footer as any).state().exit).toBe(1)
      expect((ctx.footer as any).state().status).toBe("Press Ctrl-c again to exit")
      expect(ctx.exits()).toBe(0)

      expect(ctx.footer.requestExit()).toBe(true)
      expect(ctx.footer.isClosed).toBe(true)
      expect((ctx.footer as any).state().exit).toBe(0)
      expect((ctx.footer as any).state().status).toBe("exiting")
      expect(ctx.exits()).toBe(1)

      expect(ctx.footer.requestExit()).toBe(true)
      expect(ctx.exits()).toBe(1)
    } finally {
      ctx.destroy()
    }
  })

  test("row sync clamps footer resize range", async () => {
    const ctx = await create()

    try {
      const sync = (ctx.footer as any).syncRows as (rows: number) => void
      expect(ctx.setup.renderer.footerHeight).toBe(6)
      sync(99)
      expect(ctx.setup.renderer.footerHeight).toBe(11)
      sync(-3)
      expect(ctx.setup.renderer.footerHeight).toBe(6)
    } finally {
      ctx.destroy()
    }
  })
})
