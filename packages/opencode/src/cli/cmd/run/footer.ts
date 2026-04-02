import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { Keybind } from "../../../util/keybind"
import { RunFooterView, TEXTAREA_MAX_ROWS, TEXTAREA_MIN_ROWS } from "./footer.view"
import { entryWriter, normalizeEntry } from "./scrollback"
import type { RunTheme } from "./theme"
import type { FooterApi, FooterKeybinds, FooterPatch, FooterState, StreamCommit } from "./types"

type CycleResult = {
  modelLabel?: string
  status?: string
}

type RunFooterOptions = {
  agentLabel: string
  modelLabel: string
  first: boolean
  history?: string[]
  theme: RunTheme
  keybinds: FooterKeybinds
  onCycleVariant?: () => CycleResult | void
  onInterrupt?: () => void
  onExit?: () => void
}

export class RunFooter implements FooterApi {
  private closed = false
  private destroyed = false
  private prompts = new Set<(text: string) => void>()
  private closes = new Set<() => void>()
  private base: number
  private rows = TEXTAREA_MIN_ROWS
  private state: Accessor<FooterState>
  private setState: Setter<FooterState>
  private settle = false
  private interruptTimeout: NodeJS.Timeout | undefined
  private exitTimeout: NodeJS.Timeout | undefined
  private interruptHint: string

  constructor(
    private renderer: CliRenderer,
    private options: RunFooterOptions,
  ) {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: options.modelLabel,
      duration: "",
      usage: "",
      first: options.first,
      interrupt: 0,
      exit: 0,
    })
    this.state = state
    this.setState = setState
    this.base = Math.max(1, renderer.footerHeight - TEXTAREA_MIN_ROWS)
    this.interruptHint = this.printableBinding(options.keybinds.interrupt, options.keybinds.leader) || "esc"

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)

    void render(
      () =>
        createComponent(RunFooterView, {
          state: this.state,
          theme: options.theme.footer,
          keybinds: options.keybinds,
          history: options.history,
          agent: options.agentLabel,
          onSubmit: this.handlePrompt,
          onCycle: this.handleCycle,
          onInterrupt: this.handleInterrupt,
          onExitRequest: this.handleExit,
          onExit: () => this.close(),
          onRows: this.syncRows,
          onStatus: this.setStatus,
        }),
      this.renderer as unknown as Parameters<typeof render>[1],
    ).catch(() => {
      if (!this.destroyed && !this.renderer.isDestroyed) {
        this.close()
      }
    })
  }

  public get isClosed(): boolean {
    return this.closed || this.destroyed || this.renderer.isDestroyed
  }

  public onPrompt(fn: (text: string) => void): () => void {
    this.prompts.add(fn)
    return () => {
      this.prompts.delete(fn)
    }
  }

  public onClose(fn: () => void): () => void {
    if (this.isClosed) {
      fn()
      return () => {}
    }

    this.closes.add(fn)
    return () => {
      this.closes.delete(fn)
    }
  }

  public patch(next: FooterPatch): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const prev = this.state()
    const state = {
      phase: next.phase ?? prev.phase,
      status: typeof next.status === "string" ? next.status : prev.status,
      queue: typeof next.queue === "number" ? Math.max(0, next.queue) : prev.queue,
      model: typeof next.model === "string" ? next.model : prev.model,
      duration: typeof next.duration === "string" ? next.duration : prev.duration,
      usage: typeof next.usage === "string" ? next.usage : prev.usage,
      first: typeof next.first === "boolean" ? next.first : prev.first,
      interrupt:
        typeof next.interrupt === "number" && Number.isFinite(next.interrupt)
          ? Math.max(0, Math.floor(next.interrupt))
          : prev.interrupt,
      exit:
        typeof next.exit === "number" && Number.isFinite(next.exit) ? Math.max(0, Math.floor(next.exit)) : prev.exit,
    }

    if (state.phase === "idle") {
      state.interrupt = 0
    }

    this.setState(state)
  }

  public append(commit: StreamCommit): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    if (!normalizeEntry(commit)) {
      return
    }

    this.renderer.writeToScrollback(entryWriter(commit, this.options.theme.entry))
    this.scheduleSettleRender()
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.notifyClose()
  }

  public requestExit(): boolean {
    return this.handleExit()
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.prompts.clear()
    this.closes.clear()
  }

  private notifyClose(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    for (const fn of [...this.closes]) {
      fn()
    }
  }

  private setStatus = (status: string): void => {
    this.patch({ status })
  }

  private syncRows = (value: number): void => {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const rows = Math.max(TEXTAREA_MIN_ROWS, Math.min(TEXTAREA_MAX_ROWS, value))
    if (rows === this.rows) {
      return
    }

    this.rows = rows
    const min = this.base + TEXTAREA_MIN_ROWS
    const max = this.base + TEXTAREA_MAX_ROWS
    const height = Math.max(min, Math.min(max, this.base + rows))

    if (height !== this.renderer.footerHeight) {
      this.renderer.footerHeight = height
    }
  }

  private handlePrompt = (text: string): boolean => {
    if (this.isClosed) {
      return false
    }

    if (this.state().first) {
      this.patch({ first: false })
    }

    if (this.prompts.size === 0) {
      this.patch({ status: "input queue unavailable" })
      return false
    }

    for (const fn of [...this.prompts]) {
      fn(text)
    }

    return true
  }

  private handleCycle = (): void => {
    const result = this.options.onCycleVariant?.()
    if (!result) {
      this.patch({ status: "no variants available" })
      return
    }

    const patch: FooterPatch = {
      status: result.status ?? "variant updated",
    }

    if (result.modelLabel) {
      patch.model = result.modelLabel
    }

    this.patch(patch)
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimeout) {
      return
    }

    clearTimeout(this.interruptTimeout)
    this.interruptTimeout = undefined
  }

  private armInterruptTimer(): void {
    this.clearInterruptTimer()
    this.interruptTimeout = setTimeout(() => {
      this.interruptTimeout = undefined
      if (this.destroyed || this.renderer.isDestroyed || this.state().phase !== "running") {
        return
      }

      this.patch({ interrupt: 0 })
    }, 5000)
  }

  private clearExitTimer(): void {
    if (!this.exitTimeout) {
      return
    }

    clearTimeout(this.exitTimeout)
    this.exitTimeout = undefined
  }

  private armExitTimer(): void {
    this.clearExitTimer()
    this.exitTimeout = setTimeout(() => {
      this.exitTimeout = undefined
      if (this.destroyed || this.renderer.isDestroyed || this.isClosed) {
        return
      }

      this.patch({ exit: 0 })
    }, 5000)
  }

  private handleInterrupt = (): boolean => {
    if (this.isClosed || this.state().phase !== "running") {
      return false
    }

    const next = this.state().interrupt + 1
    this.patch({ interrupt: next })

    if (next < 2) {
      this.armInterruptTimer()
      this.patch({ status: `${this.interruptHint} again to interrupt` })
      return true
    }

    this.clearInterruptTimer()
    this.patch({ interrupt: 0, status: "interrupting" })
    this.options.onInterrupt?.()
    return true
  }

  private handleExit = (): boolean => {
    if (this.isClosed) {
      return true
    }

    this.clearInterruptTimer()
    const next = this.state().exit + 1
    this.patch({ exit: next, interrupt: 0 })

    if (next < 2) {
      this.armExitTimer()
      this.patch({ status: "Press Ctrl-c again to exit" })
      return true
    }

    this.clearExitTimer()
    this.patch({ exit: 0, status: "exiting" })
    this.close()
    this.options.onExit?.()
    return true
  }

  private printableBinding(binding: string, leader: string): string {
    const first = Keybind.parse(binding).at(0)
    if (!first) {
      return ""
    }

    let text = Keybind.toString(first)
    const lead = Keybind.parse(leader).at(0)
    if (lead) {
      text = text.replace("<leader>", Keybind.toString(lead))
    }

    text = text.replace(/escape/g, "esc")

    return text
  }

  private handleDestroy = (): void => {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.prompts.clear()
    this.closes.clear()
  }

  private scheduleSettleRender(): void {
    if (this.settle || this.destroyed || this.renderer.isDestroyed) {
      return
    }

    this.settle = true
    void this.renderer
      .idle()
      .then(() => {
        if (this.destroyed || this.renderer.isDestroyed || this.closed) {
          return
        }

        this.renderer.requestRender()
      })
      .catch(() => {})
      .finally(() => {
        this.settle = false
      })
  }
}
