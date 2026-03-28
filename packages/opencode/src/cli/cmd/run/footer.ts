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
import { directEntryWriter } from "./scrollback"
import type { DirectEntryKind } from "./types"

const HIGHLIGHT_COLOR = "#38bdf8"
const MUTED_COLOR = "#64748b"
const TEXT_COLOR = "#f8fafc"
const BORDER_COLOR = "#334155"

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

function directTextareaKeybindings(): KeyBinding[] {
  return [
    { name: "return", action: "submit" },
    { name: "linefeed", action: "submit" },
    { name: "return", shift: true, action: "newline" },
    { name: "linefeed", shift: true, action: "newline" },
    { name: "return", ctrl: true, action: "newline" },
    { name: "linefeed", ctrl: true, action: "newline" },
    { name: "return", meta: true, action: "newline" },
    { name: "linefeed", meta: true, action: "newline" },
    { name: "j", ctrl: true, action: "newline" },
  ]
}

function isExitCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase()
  return normalized === "/exit" || normalized === "/quit"
}

export type ScrollbackRenderer = CliRenderer & {
  writeToScrollback: (write: ScrollbackWriter) => void
}

type FooterHistoryState = {
  items: string[]
  index: number | null
  draft: string
}

export class DirectRunFooter {
  private shell: BoxRenderable
  private composerFrame: BoxRenderable
  private composerArea: BoxRenderable
  private composer: TextareaRenderable
  private metaRow: BoxRenderable
  private agentText: TextRenderable
  private modelText: TextRenderable
  private separatorRow: BoxRenderable
  private separatorLine: BoxRenderable
  private footerRow: BoxRenderable
  private statusText: TextRenderable
  private hintText: TextRenderable
  private pendingInput: ((value: string | null) => void) | null = null
  private closed = false
  private busy = false
  private destroyed = false
  private statusMessage = "ready"
  private history: FooterHistoryState = {
    items: [],
    index: null,
    draft: "",
  }

  constructor(
    private renderer: ScrollbackRenderer,
    info: {
      agentLabel: string
      modelLabel: string
    },
  ) {
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

    this.composer = new TextareaRenderable(renderer, {
      id: "run-direct-footer-composer",
      width: "100%",
      minHeight: 1,
      maxHeight: 6,
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
      keyBindings: directTextareaKeybindings(),
    })

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
      content: info.agentLabel,
      fg: HIGHLIGHT_COLOR,
    })

    this.modelText = new TextRenderable(renderer, {
      id: "run-direct-footer-model",
      content: info.modelLabel,
      fg: MUTED_COLOR,
    })

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

    this.statusText = new TextRenderable(renderer, {
      id: "run-direct-footer-status",
      content: "",
      fg: TEXT_COLOR,
    })

    this.hintText = new TextRenderable(renderer, {
      id: "run-direct-footer-hint",
      content: "",
      fg: MUTED_COLOR,
    })

    this.metaRow.add(this.agentText)
    this.metaRow.add(this.modelText)

    this.composerArea.add(this.composer)
    this.composerArea.add(this.metaRow)
    this.composerFrame.add(this.composerArea)

    this.separatorRow.add(this.separatorLine)

    this.footerRow.add(this.statusText)
    this.footerRow.add(this.hintText)

    this.shell.add(this.composerFrame)
    this.shell.add(this.separatorRow)
    this.shell.add(this.footerRow)
    this.renderer.root.add(this.shell)

    this.composer.on("line-info-change", this.handleDraftChanged)
    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)
    this.refreshFooterRow()
    this.composer.focus()
  }

  public get isClosed(): boolean {
    return this.closed || this.destroyed || this.renderer.isDestroyed
  }

  public setStatus(status: string): void {
    this.statusMessage = status
    this.refreshFooterRow()
  }

  public setBusy(status: string): void {
    this.busy = true
    this.setStatus(status)
  }

  public setIdle(status: string = "ready"): void {
    this.busy = false
    this.setStatus(status)
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

    this.setIdle("ready")
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

    const pending = this.pendingInput
    this.pendingInput = null
    pending?.(null)

    this.composer.off("line-info-change", this.handleDraftChanged)
    this.composer.onSubmit = undefined
    this.composer.onKeyDown = undefined
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)

    if (!this.renderer.isDestroyed) {
      this.renderer.root.remove(this.shell.id)
    }
  }

  private refreshFooterRow(): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const draftLength = this.composer.isDestroyed ? 0 : this.composer.plainText.length
    const busyLabel = this.busy ? "busy" : "idle"
    this.statusText.content = `run -i · ${this.statusMessage} · ${busyLabel} · draft ${draftLength}`
    this.hintText.content = this.busy
      ? "waiting for response · /exit quit"
      : "Enter send · Shift/Ctrl/Alt+Enter newline · Up/Down history · /exit quit"
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
    this.composer.focus()

    const pending = this.pendingInput
    this.pendingInput = null
    pending(input)
  }

  private handleDraftChanged = (): void => {
    this.refreshFooterRow()
  }

  private handleDestroy = (): void => {
    this.closed = true
    const pending = this.pendingInput
    this.pendingInput = null
    pending?.(null)
  }
}
