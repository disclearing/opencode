import {
  BoxRenderable,
  CliRenderEvents,
  TextRenderable,
  TextareaRenderable,
  type CliRenderer,
  type KeyBinding,
  type KeyEvent,
  type ScrollbackWriter,
} from "@opentui/core"
import { Keybind } from "../../../util/keybind"
import { directEntryWriter } from "./scrollback"
import type { DirectEntryKind } from "./types"

const HIGHLIGHT_COLOR = "#38bdf8"
const MUTED_COLOR = "#64748b"
const TEXT_COLOR = "#f8fafc"
const BORDER_COLOR = "#334155"

const LEADER_TIMEOUT_MS = 2000
const TEXTAREA_MIN_HEIGHT = 1
const TEXTAREA_MAX_HEIGHT = 6

const HINT_WIDTH_BREAKPOINTS = {
  send: 50,
  newline: 66,
  history: 80,
  variant: 95,
}

const EMPTY_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

function isExitCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase()
  return normalized === "/exit" || normalized === "/quit"
}

function mapInputBindings(binding: string, action: "submit" | "newline"): KeyBinding[] {
  return Keybind.parse(binding).map((item) => ({
    name: item.name,
    ctrl: item.ctrl || undefined,
    meta: item.meta || undefined,
    shift: item.shift || undefined,
    super: item.super || undefined,
    action,
  }))
}

function directTextareaKeybindings(keybinds: DirectFooterKeybinds): KeyBinding[] {
  return [
    { name: "return", action: "submit" },
    { name: "return", meta: true, action: "newline" },
    ...mapInputBindings(keybinds.inputSubmit, "submit"),
    ...mapInputBindings(keybinds.inputNewline, "newline"),
  ]
}

function printableBinding(binding: string, leader: string): string {
  const first = Keybind.parse(binding).at(0)
  if (!first) {
    return ""
  }

  let text = Keybind.toString(first)
  const leaderKey = Keybind.parse(leader).at(0)
  if (leaderKey) {
    text = text.replace("<leader>", Keybind.toString(leaderKey))
  }

  return text
}

function toKeyInfo(event: KeyEvent, leader: boolean): Keybind.Info {
  return {
    name: event.name === " " ? "space" : event.name,
    ctrl: !!event.ctrl,
    meta: !!event.meta,
    shift: !!event.shift,
    super: !!event.super,
    leader,
  }
}

export type ScrollbackRenderer = CliRenderer & {
  writeToScrollback: (write: ScrollbackWriter) => void
}

type FooterHistoryState = {
  items: string[]
  index: number | null
  draft: string
}

export type DirectFooterKeybinds = {
  leader: string
  variantCycle: string
  inputSubmit: string
  inputNewline: string
}

type VariantCycleResult = {
  modelLabel?: string
  status?: string
}

type DirectRunFooterOptions = {
  agentLabel: string
  modelLabel: string
  keybinds: DirectFooterKeybinds
  onCycleVariant?: () => VariantCycleResult | void
}

export class DirectRunFooter {
  private shell: BoxRenderable
  private composerFrame: BoxRenderable
  private composerArea: BoxRenderable
  private topStatusRow: BoxRenderable
  private topStatusSpinner: TextRenderable
  private topStatusText: TextRenderable
  private composer: TextareaRenderable
  private metaRow: BoxRenderable
  private agentText: TextRenderable
  private modelText: TextRenderable
  private separatorRow: BoxRenderable
  private separatorLine: BoxRenderable
  private footerRow: BoxRenderable
  private footerSpacer: BoxRenderable
  private hintGroup: BoxRenderable
  private hintSendText: TextRenderable
  private hintNewlineText: TextRenderable
  private hintHistoryText: TextRenderable
  private hintVariantText: TextRenderable
  private hintExitText: TextRenderable
  private pendingInput: ((value: string | null) => void) | null = null
  private closed = false
  private busy = false
  private destroyed = false
  private statusMessage = ""
  private readonly agentLabel: string
  private defaultStatus = ""
  private history: FooterHistoryState = {
    items: [],
    index: null,
    draft: "",
  }

  private leaderBindings: Keybind.Info[]
  private variantCycleBindings: Keybind.Info[]
  private leaderActive = false
  private leaderTimeout: NodeJS.Timeout | undefined
  private variantHint: string
  private footerBaseRows = 0
  private composerRows = TEXTAREA_MIN_HEIGHT

  constructor(
    private renderer: ScrollbackRenderer,
    private options: DirectRunFooterOptions,
  ) {
    this.agentLabel = options.agentLabel
    this.leaderBindings = Keybind.parse(options.keybinds.leader)
    this.variantCycleBindings = Keybind.parse(options.keybinds.variantCycle)
    this.variantHint = printableBinding(options.keybinds.variantCycle, options.keybinds.leader)

    this.shell = new BoxRenderable(renderer, {
      id: "run-direct-footer-shell",
      width: "100%",
      height: "100%",
      border: false,
      backgroundColor: "transparent",
      padding: 0,
      gap: 0,
      flexDirection: "column",
    })

    this.composerFrame = new BoxRenderable(renderer, {
      id: "run-direct-footer-composer-frame",
      width: "100%",
      flexShrink: 0,
      border: ["left"],
      borderColor: HIGHLIGHT_COLOR,
      customBorderChars: {
        ...EMPTY_BORDER,
        vertical: "┃",
        bottomLeft: "╹",
      },
    })

    this.composerArea = new BoxRenderable(renderer, {
      id: "run-direct-footer-composer-area",
      width: "100%",
      flexGrow: 1,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      gap: 0,
      flexDirection: "column",
      backgroundColor: "transparent",
    })

    this.topStatusRow = new BoxRenderable(renderer, {
      id: "run-direct-footer-top-status-row",
      width: "100%",
      height: 1,
      flexDirection: "row",
      gap: 1,
      flexShrink: 0,
    })

    this.topStatusSpinner = new TextRenderable(renderer, {
      id: "run-direct-footer-top-status-spinner",
      content: "[⋯]",
      fg: HIGHLIGHT_COLOR,
      wrapMode: "none",
      truncate: true,
      flexShrink: 0,
      visible: false,
    })

    this.topStatusText = new TextRenderable(renderer, {
      id: "run-direct-footer-top-status-text",
      content: "",
      fg: MUTED_COLOR,
      wrapMode: "none",
      truncate: true,
      flexGrow: 1,
      flexShrink: 1,
    })

    this.composer = new TextareaRenderable(renderer, {
      id: "run-direct-footer-composer",
      width: "100%",
      minHeight: TEXTAREA_MIN_HEIGHT,
      maxHeight: TEXTAREA_MAX_HEIGHT,
      wrapMode: "word",
      showCursor: true,
      placeholder: 'Ask anything... "Fix a TODO in the codebase"',
      placeholderColor: MUTED_COLOR,
      textColor: TEXT_COLOR,
      focusedTextColor: TEXT_COLOR,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      cursorColor: TEXT_COLOR,
      onSubmit: this.handleSubmit,
      onKeyDown: this.handleComposerKeyDown,
      keyBindings: directTextareaKeybindings(options.keybinds),
    })

    this.composerRows = Math.max(TEXTAREA_MIN_HEIGHT, Math.min(TEXTAREA_MAX_HEIGHT, this.composer.virtualLineCount || 1))
    this.footerBaseRows = Math.max(1, this.renderer.footerHeight - this.composerRows)

    this.metaRow = new BoxRenderable(renderer, {
      id: "run-direct-footer-meta-row",
      width: "100%",
      flexDirection: "row",
      gap: 1,
      paddingTop: 1,
      flexShrink: 0,
    })

    this.agentText = new TextRenderable(renderer, {
      id: "run-direct-footer-agent",
      content: options.agentLabel,
      fg: HIGHLIGHT_COLOR,
      wrapMode: "none",
      truncate: true,
      flexShrink: 0,
    })

    this.modelText = new TextRenderable(renderer, {
      id: "run-direct-footer-model",
      content: options.modelLabel,
      fg: MUTED_COLOR,
      wrapMode: "none",
      truncate: true,
      flexGrow: 1,
      flexShrink: 1,
    })

    this.defaultStatus = `${this.agentLabel} · ${options.modelLabel}`

    this.separatorRow = new BoxRenderable(renderer, {
      id: "run-direct-footer-separator-row",
      width: "100%",
      height: 1,
      border: ["left"],
      borderColor: HIGHLIGHT_COLOR,
      customBorderChars: {
        ...EMPTY_BORDER,
        vertical: "╹",
      },
    })

    this.separatorLine = new BoxRenderable(renderer, {
      id: "run-direct-footer-separator-line",
      width: "100%",
      height: 1,
      border: ["bottom"],
      borderColor: BORDER_COLOR,
      customBorderChars: {
        ...EMPTY_BORDER,
        horizontal: "─",
      },
    })

    this.footerRow = new BoxRenderable(renderer, {
      id: "run-direct-footer-row",
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 1,
      flexShrink: 0,
    })

    this.footerSpacer = new BoxRenderable(renderer, {
      id: "run-direct-footer-spacer",
      flexGrow: 1,
      flexShrink: 1,
      backgroundColor: "transparent",
    })

    this.hintGroup = new BoxRenderable(renderer, {
      id: "run-direct-footer-hint-group",
      flexDirection: "row",
      gap: 2,
      flexShrink: 0,
      justifyContent: "flex-end",
    })

    this.hintSendText = new TextRenderable(renderer, {
      id: "run-direct-footer-hint-send",
      content: "Enter send",
      fg: TEXT_COLOR,
      wrapMode: "none",
      truncate: true,
    })

    this.hintNewlineText = new TextRenderable(renderer, {
      id: "run-direct-footer-hint-newline",
      content: "Shift+Enter newline",
      fg: MUTED_COLOR,
      wrapMode: "none",
      truncate: true,
    })

    this.hintHistoryText = new TextRenderable(renderer, {
      id: "run-direct-footer-hint-history",
      content: "Up/Down history",
      fg: MUTED_COLOR,
      wrapMode: "none",
      truncate: true,
    })

    this.hintVariantText = new TextRenderable(renderer, {
      id: "run-direct-footer-hint-variant",
      content: this.variantHint ? `${this.variantHint} variant` : "",
      fg: MUTED_COLOR,
      wrapMode: "none",
      truncate: true,
      visible: false,
    })

    this.hintExitText = new TextRenderable(renderer, {
      id: "run-direct-footer-hint-exit",
      content: "/exit",
      fg: MUTED_COLOR,
      wrapMode: "none",
      truncate: true,
    })

    this.topStatusRow.add(this.topStatusSpinner)
    this.topStatusRow.add(this.topStatusText)

    this.metaRow.add(this.agentText)
    this.metaRow.add(this.modelText)

    this.composerArea.add(this.topStatusRow)
    this.composerArea.add(this.composer)
    this.composerArea.add(this.metaRow)
    this.composerFrame.add(this.composerArea)

    this.separatorRow.add(this.separatorLine)

    this.hintGroup.add(this.hintSendText)
    this.hintGroup.add(this.hintNewlineText)
    this.hintGroup.add(this.hintHistoryText)
    this.hintGroup.add(this.hintVariantText)
    this.hintGroup.add(this.hintExitText)

    this.footerRow.add(this.footerSpacer)
    this.footerRow.add(this.hintGroup)

    this.shell.add(this.composerFrame)
    this.shell.add(this.separatorRow)
    this.shell.add(this.footerRow)
    this.renderer.root.add(this.shell)

    this.composer.on("line-info-change", this.handleDraftChanged)
    this.renderer.on(CliRenderEvents.RESIZE, this.handleResize)
    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)
    this.syncFooterHeightFromComposer()
    this.refreshFooterRow()
    this.composer.focus()
  }

  public get isClosed(): boolean {
    return this.closed || this.destroyed || this.renderer.isDestroyed
  }

  public setModelLabel(label: string): void {
    this.modelText.content = label
    this.defaultStatus = `${this.agentLabel} · ${label}`
    this.refreshFooterRow()
  }

  public setStatus(status: string): void {
    this.statusMessage = status
    this.refreshFooterRow()
  }

  public setBusy(status: string): void {
    this.busy = true
    this.setStatus(status)
  }

  public setIdle(status = ""): void {
    this.busy = false
    this.setStatus(status || this.defaultStatus)
    this.composer.focus()
  }

  public append(kind: DirectEntryKind, text: string): void {
    if (this.destroyed || this.renderer.isDestroyed) return
    if (text.trim().length === 0) return
    this.renderer.writeToScrollback(directEntryWriter(kind, text, new Date()))
  }

  public waitForInput(): Promise<string | null> {
    if (this.isClosed) {
      return Promise.resolve(null)
    }

    this.setIdle("")
    return new Promise((resolve) => {
      this.pendingInput = resolve
      this.composer.focus()
    })
  }

  public close(): void {
    if (this.closed) return
    this.closed = true

    const pending = this.pendingInput
    this.pendingInput = null
    pending?.(null)

    if (!this.renderer.isDestroyed) {
      this.renderer.destroy()
    }
  }

  public destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.closed = true

    if (this.leaderTimeout) {
      clearTimeout(this.leaderTimeout)
      this.leaderTimeout = undefined
    }

    const pending = this.pendingInput
    this.pendingInput = null
    pending?.(null)

    this.composer.off("line-info-change", this.handleDraftChanged)
    this.composer.onSubmit = undefined
    this.composer.onKeyDown = undefined
    this.renderer.off(CliRenderEvents.RESIZE, this.handleResize)
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)

    if (!this.renderer.isDestroyed) {
      this.renderer.root.remove(this.shell.id)
    }
  }

  private refreshFooterRow(): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const width = this.renderer.width
    const statusText = this.busy
      ? this.statusMessage || "assistant responding"
      : this.statusMessage || this.defaultStatus

    this.topStatusRow.visible = true
    this.topStatusSpinner.visible = this.busy
    this.topStatusText.content = statusText
    this.topStatusText.fg = this.busy ? HIGHLIGHT_COLOR : MUTED_COLOR

    if (this.busy) {
      this.hintSendText.visible = false
      this.hintNewlineText.visible = false
      this.hintHistoryText.visible = false
      this.hintVariantText.visible = false
      this.hintExitText.visible = true
      this.hintExitText.content = "/exit quit"
      this.hintExitText.fg = TEXT_COLOR
      return
    }

    this.hintSendText.visible = width >= HINT_WIDTH_BREAKPOINTS.send
    this.hintNewlineText.visible = width >= HINT_WIDTH_BREAKPOINTS.newline
    this.hintHistoryText.visible = width >= HINT_WIDTH_BREAKPOINTS.history
    this.hintVariantText.visible = this.variantHint.length > 0 && width >= HINT_WIDTH_BREAKPOINTS.variant
    this.hintExitText.visible = true
    this.hintExitText.content = "/exit"
    this.hintExitText.fg = MUTED_COLOR
  }

  private syncFooterHeightFromComposer(): void {
    if (this.destroyed || this.renderer.isDestroyed || this.composer.isDestroyed) {
      return
    }

    const nextRows = Math.max(TEXTAREA_MIN_HEIGHT, Math.min(TEXTAREA_MAX_HEIGHT, this.composer.virtualLineCount || 1))
    if (nextRows === this.composerRows) {
      return
    }

    const delta = nextRows - this.composerRows
    this.composerRows = nextRows

    const minHeight = this.footerBaseRows + TEXTAREA_MIN_HEIGHT
    const maxHeight = this.footerBaseRows + TEXTAREA_MAX_HEIGHT
    const nextHeight = Math.max(minHeight, Math.min(maxHeight, this.renderer.footerHeight + delta))

    if (nextHeight !== this.renderer.footerHeight) {
      this.renderer.footerHeight = nextHeight
    }
  }

  private matches(bindings: Keybind.Info[], event: Keybind.Info): boolean {
    for (const binding of bindings) {
      if (Keybind.match(binding, event)) {
        return true
      }
    }
    return false
  }

  private clearLeader(): void {
    this.leaderActive = false
    if (this.leaderTimeout) {
      clearTimeout(this.leaderTimeout)
      this.leaderTimeout = undefined
    }
  }

  private armLeader(): void {
    this.clearLeader()
    this.leaderActive = true
    this.leaderTimeout = setTimeout(() => {
      this.clearLeader()
    }, LEADER_TIMEOUT_MS)
  }

  private runVariantCycle(): void {
    const result = this.options.onCycleVariant?.()
    if (!result) {
      this.setStatus("no variants available")
      return
    }

    if (result.modelLabel) {
      this.setModelLabel(result.modelLabel)
    }

    this.setStatus(result.status ?? "variant updated")
  }

  private handleVariantCycleKey = (event: KeyEvent): boolean => {
    const plain = toKeyInfo(event, false)

    if (!this.leaderActive && this.matches(this.leaderBindings, plain)) {
      this.armLeader()
      event.preventDefault()
      return true
    }

    if (this.leaderActive) {
      const withLeader = toKeyInfo(event, true)
      const matched = this.matches(this.variantCycleBindings, withLeader)
      this.clearLeader()
      event.preventDefault()

      if (matched) {
        this.runVariantCycle()
      }

      return true
    }

    if (this.matches(this.variantCycleBindings, plain)) {
      this.runVariantCycle()
      event.preventDefault()
      return true
    }

    return false
  }

  private pushHistory(input: string): void {
    if (!input) {
      return
    }

    if (this.history.items[this.history.items.length - 1] === input) {
      this.history.index = null
      this.history.draft = ""
      return
    }

    this.history.items.push(input)
    if (this.history.items.length > 200) {
      this.history.items.shift()
    }
    this.history.index = null
    this.history.draft = ""
  }

  private moveHistory(direction: -1 | 1, event: KeyEvent): void {
    if (this.history.items.length === 0) {
      return
    }

    if (direction === -1 && this.composer.cursorOffset !== 0) {
      return
    }

    if (direction === 1 && this.composer.cursorOffset !== this.composer.plainText.length) {
      return
    }

    if (this.history.index === null) {
      if (direction === 1) {
        return
      }

      this.history.draft = this.composer.plainText
      this.history.index = this.history.items.length - 1
    } else {
      const nextIndex = this.history.index + direction
      if (nextIndex < 0) {
        return
      }

      if (nextIndex >= this.history.items.length) {
        this.history.index = null
        this.composer.setText(this.history.draft)
        this.composer.cursorOffset = this.composer.plainText.length
        event.preventDefault()
        this.refreshFooterRow()
        return
      }

      this.history.index = nextIndex
    }

    const next = this.history.items[this.history.index]
    this.composer.setText(next)
    this.composer.cursorOffset = direction === -1 ? 0 : this.composer.plainText.length
    event.preventDefault()
    this.refreshFooterRow()
  }

  private handleComposerKeyDown = (event: KeyEvent): void => {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    if (this.handleVariantCycleKey(event)) {
      return
    }

    if (event.ctrl || event.meta || event.shift || event.super || event.hyper) {
      return
    }

    if (event.name === "up") {
      this.moveHistory(-1, event)
      return
    }

    if (event.name === "down") {
      this.moveHistory(1, event)
    }
  }

  private handleSubmit = (): void => {
    if (this.destroyed || this.renderer.isDestroyed) return

    const input = this.composer.plainText.trim()

    if (!input) {
      this.setStatus(this.busy ? "waiting for current response" : "empty prompt ignored")
      return
    }

    if (isExitCommand(input)) {
      this.close()
      return
    }

    if (this.busy) {
      this.setStatus("waiting for current response")
      return
    }

    if (!this.pendingInput) {
      this.setStatus("input queue unavailable")
      return
    }

    this.pushHistory(input)
    this.composer.setText("")
    this.syncFooterHeightFromComposer()
    this.composer.focus()

    const pending = this.pendingInput
    this.pendingInput = null
    pending(input)
  }

  private handleDraftChanged = (): void => {
    this.syncFooterHeightFromComposer()
    this.refreshFooterRow()
  }

  private handleResize = (): void => {
    this.syncFooterHeightFromComposer()
    this.refreshFooterRow()
  }

  private handleDestroy = (): void => {
    this.closed = true
    if (this.leaderTimeout) {
      clearTimeout(this.leaderTimeout)
      this.leaderTimeout = undefined
    }
    const pending = this.pendingInput
    this.pendingInput = null
    pending?.(null)
  }
}
