import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { RunFooterView, TEXTAREA_MAX_ROWS, TEXTAREA_MIN_ROWS } from "./footer.view"
import { entryWriter } from "./scrollback"
import type { EntryKind, FooterApi, FooterKeybinds, FooterPatch, FooterState } from "./types"

type CycleResult = {
  modelLabel?: string
  status?: string
}

type RunFooterOptions = {
  agentLabel: string
  modelLabel: string
  keybinds: FooterKeybinds
  onCycleVariant?: () => CycleResult | void
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

  constructor(
    private renderer: CliRenderer,
    private options: RunFooterOptions,
  ) {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: options.modelLabel,
    })
    this.state = state
    this.setState = setState
    this.base = Math.max(1, renderer.footerHeight - TEXTAREA_MIN_ROWS)

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)

    void render(
      () =>
        createComponent(RunFooterView, {
          state: this.state,
          keybinds: options.keybinds,
          agent: options.agentLabel,
          onSubmit: this.handlePrompt,
          onCycle: this.handleCycle,
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

    this.setState((state) => ({
      phase: next.phase ?? state.phase,
      status: typeof next.status === "string" ? next.status : state.status,
      queue: typeof next.queue === "number" ? Math.max(0, next.queue) : state.queue,
      model: typeof next.model === "string" ? next.model : state.model,
    }))
  }

  public append(kind: EntryKind, text: string): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    if (!text.trim()) {
      return
    }

    this.renderer.writeToScrollback(entryWriter(kind, text, new Date()))
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.notifyClose()

    if (!this.renderer.isDestroyed) {
      this.renderer.destroy()
    }
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.notifyClose()
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

  private handleDestroy = (): void => {
    this.notifyClose()
  }
}
