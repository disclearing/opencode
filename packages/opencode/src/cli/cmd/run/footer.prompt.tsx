/** @jsxImportSource @opentui/solid */
import { StyledText, bg, fg, type KeyBinding } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { Keybind } from "../../../util/keybind"
import type { FooterKeybinds, FooterState } from "./types"
import type { RunFooterTheme } from "./theme"

const LEADER_TIMEOUT_MS = 2000

export const TEXTAREA_MIN_ROWS = 1
export const TEXTAREA_MAX_ROWS = 6

export const HINT_BREAKPOINTS = {
  send: 50,
  newline: 66,
  history: 80,
  variant: 95,
}

type History = {
  items: string[]
  index: number | null
  draft: string
}

type Area = {
  isDestroyed: boolean
  virtualLineCount: number
  visualCursor: {
    visualRow: number
  }
  plainText: string
  cursorOffset: number
  height?: number
  setText(text: string): void
  focus(): void
  on(event: string, fn: () => void): void
  off(event: string, fn: () => void): void
}

type Key = {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
  hyper?: boolean
  preventDefault(): void
}

type PromptInput = {
  keybinds: FooterKeybinds
  state: Accessor<FooterState>
  view: Accessor<string>
  prompt: Accessor<boolean>
  width: Accessor<number>
  theme: Accessor<RunFooterTheme>
  history?: string[]
  onSubmit: (text: string) => boolean
  onCycle: () => void
  onInterrupt: () => boolean
  onExitRequest?: () => boolean
  onExit: () => void
  onRows: (rows: number) => void
  onStatus: (text: string) => void
}

export type PromptState = {
  placeholder: Accessor<StyledText | string>
  bindings: Accessor<KeyBinding[]>
  onSubmit: () => void
  onKeyDown: (event: Key) => void
  onContentChange: () => void
  bind: (area?: Area) => void
}

function isExit(input: string): boolean {
  const text = input.trim().toLowerCase()
  return text === "/exit" || text === "/quit"
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

function textareaBindings(keybinds: FooterKeybinds): KeyBinding[] {
  return [
    { name: "return", action: "submit" },
    { name: "return", meta: true, action: "newline" },
    ...mapInputBindings(keybinds.inputSubmit, "submit"),
    ...mapInputBindings(keybinds.inputNewline, "newline"),
  ]
}

export function printableBinding(binding: string, leader: string): string {
  const first = Keybind.parse(binding).at(0)
  if (!first) {
    return ""
  }

  let text = Keybind.toString(first)
  const lead = Keybind.parse(leader).at(0)
  if (lead) {
    text = text.replace("<leader>", Keybind.toString(lead))
  }

  return text.replace(/escape/g, "esc")
}

function toInfo(event: Key, leader: boolean): Keybind.Info {
  return {
    name: event.name === " " ? "space" : event.name,
    ctrl: !!event.ctrl,
    meta: !!event.meta,
    shift: !!event.shift,
    super: !!event.super,
    leader,
  }
}

function hit(bindings: Keybind.Info[], event: Keybind.Info): boolean {
  return bindings.some((item) => Keybind.match(item, event))
}

function clamp(rows: number): number {
  return Math.max(TEXTAREA_MIN_ROWS, Math.min(TEXTAREA_MAX_ROWS, rows))
}

export function hintFlags(width: number) {
  return {
    send: width >= HINT_BREAKPOINTS.send,
    newline: width >= HINT_BREAKPOINTS.newline,
    history: width >= HINT_BREAKPOINTS.history,
    variant: width >= HINT_BREAKPOINTS.variant,
  }
}

export function RunPromptBody(props: {
  theme: () => RunFooterTheme
  placeholder: () => StyledText | string
  bindings: () => KeyBinding[]
  onSubmit: () => void
  onKeyDown: (event: Key) => void
  onContentChange: () => void
  bind: (area?: Area) => void
}) {
  let item: Area | undefined

  onMount(() => {
    props.bind(item)
  })

  onCleanup(() => {
    props.bind(undefined)
  })

  return (
    <textarea
      id="run-direct-footer-composer"
      width="100%"
      minHeight={TEXTAREA_MIN_ROWS}
      maxHeight={TEXTAREA_MAX_ROWS}
      wrapMode="word"
      placeholder={props.placeholder()}
      placeholderColor={props.theme().muted}
      textColor={props.theme().text}
      focusedTextColor={props.theme().text}
      backgroundColor={props.theme().surface}
      focusedBackgroundColor={props.theme().surface}
      cursorColor={props.theme().text}
      keyBindings={props.bindings()}
      onSubmit={props.onSubmit}
      onKeyDown={props.onKeyDown}
      onContentChange={props.onContentChange}
      ref={(next) => {
        item = next as Area
      }}
    />
  )
}

export function createPromptState(input: PromptInput): PromptState {
  const leaders = createMemo(() => Keybind.parse(input.keybinds.leader))
  const cycles = createMemo(() => Keybind.parse(input.keybinds.variantCycle))
  const interrupts = createMemo(() => Keybind.parse(input.keybinds.interrupt))
  const previous = createMemo(() => Keybind.parse(input.keybinds.historyPrevious))
  const next = createMemo(() => Keybind.parse(input.keybinds.historyNext))
  const bindings = createMemo(() => textareaBindings(input.keybinds))
  const [draft, setDraft] = createSignal("")
  const placeholder = createMemo(() => {
    if (!input.state().first) {
      return ""
    }

    return new StyledText([
      bg(input.theme().surface)(fg(input.theme().muted)('Ask anything... "Fix a TODO in the codebase"')),
    ])
  })

  const history: History = {
    items: (input.history ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item, idx, all) => idx === 0 || item !== all[idx - 1])
      .slice(-200),
    index: null,
    draft: "",
  }

  let area: Area | undefined
  let leader = false
  let timeout: NodeJS.Timeout | undefined
  let tick = false
  let prev = input.view()

  const clear = () => {
    leader = false
    if (!timeout) {
      return
    }

    clearTimeout(timeout)
    timeout = undefined
  }

  const arm = () => {
    clear()
    leader = true
    timeout = setTimeout(() => {
      clear()
    }, LEADER_TIMEOUT_MS)
  }

  const syncRows = () => {
    if (!area || area.isDestroyed) {
      return
    }

    input.onRows(clamp(area.virtualLineCount || 1))
  }

  const scheduleRows = () => {
    if (tick) {
      return
    }

    tick = true
    queueMicrotask(() => {
      tick = false
      syncRows()
    })
  }

  const bind = (next?: Area) => {
    if (area === next) {
      return
    }

    if (area && !area.isDestroyed) {
      area.off("line-info-change", scheduleRows)
    }

    area = next
    if (!area || area.isDestroyed) {
      return
    }

    area.on("line-info-change", scheduleRows)
    queueMicrotask(() => {
      if (!area || area.isDestroyed || !input.prompt()) {
        return
      }

      if (area.plainText !== draft()) {
        area.setText(draft())
      }

      area.cursorOffset = area.plainText.length
      scheduleRows()
      area.focus()
    })
  }

  const syncDraft = () => {
    if (!area || area.isDestroyed) {
      return
    }

    setDraft(area.plainText)
  }

  const push = (text: string) => {
    if (!text) {
      return
    }

    if (history.items[history.items.length - 1] === text) {
      history.index = null
      history.draft = ""
      return
    }

    history.items.push(text)
    if (history.items.length > 200) {
      history.items.shift()
    }

    history.index = null
    history.draft = ""
  }

  const move = (dir: -1 | 1, event: Key) => {
    if (!area || history.items.length === 0) {
      return
    }

    if (dir === -1 && area.cursorOffset !== 0) {
      return
    }

    if (dir === 1 && area.cursorOffset !== area.plainText.length) {
      return
    }

    if (history.index === null) {
      if (dir === 1) {
        return
      }

      history.draft = area.plainText
      history.index = history.items.length - 1
    } else {
      const idx = history.index + dir
      if (idx < 0) {
        return
      }

      if (idx >= history.items.length) {
        history.index = null
        area.setText(history.draft)
        area.cursorOffset = area.plainText.length
        event.preventDefault()
        syncRows()
        return
      }

      history.index = idx
    }

    area.setText(history.items[history.index])
    area.cursorOffset = dir === -1 ? 0 : area.plainText.length
    event.preventDefault()
    syncRows()
  }

  const cycle = (event: Key): boolean => {
    const plain = toInfo(event, false)

    if (!leader && hit(leaders(), plain)) {
      arm()
      event.preventDefault()
      return true
    }

    if (leader) {
      const key = toInfo(event, true)
      const ok = hit(cycles(), key)
      clear()
      event.preventDefault()

      if (ok) {
        input.onCycle()
      }

      return true
    }

    if (!hit(cycles(), plain)) {
      return false
    }

    input.onCycle()
    event.preventDefault()
    return true
  }

  const onKeyDown = (event: Key) => {
    if (event.ctrl && event.name === "c") {
      const handled = input.onExitRequest ? input.onExitRequest() : (input.onExit(), true)
      if (handled) {
        event.preventDefault()
      }
      return
    }

    if (hit(interrupts(), toInfo(event, false))) {
      if (input.onInterrupt()) {
        event.preventDefault()
        return
      }
    }

    if (cycle(event)) {
      return
    }

    const key = toInfo(event, false)
    const up = hit(previous(), key)
    const down = hit(next(), key)
    if (!up && !down) {
      return
    }

    if (!area || area.isDestroyed) {
      return
    }

    const dir = up ? -1 : 1
    if ((dir === -1 && area.cursorOffset === 0) || (dir === 1 && area.cursorOffset === area.plainText.length)) {
      move(dir, event)
      return
    }

    if (dir === -1 && area.visualCursor.visualRow === 0) {
      area.cursorOffset = 0
    }

    const end =
      typeof area.height === "number" && Number.isFinite(area.height) && area.height > 0
        ? area.height - 1
        : Math.max(0, area.virtualLineCount - 1)
    if (dir === 1 && area.visualCursor.visualRow === end) {
      area.cursorOffset = area.plainText.length
    }
  }

  useKeyboard((event) => {
    if (input.prompt()) {
      return
    }

    if (event.ctrl && event.name === "c") {
      const handled = input.onExitRequest ? input.onExitRequest() : (input.onExit(), true)
      if (handled) {
        event.preventDefault()
      }
    }
  })

  const onSubmit = () => {
    if (!area || area.isDestroyed) {
      return
    }

    const text = area.plainText.trim()
    if (!text) {
      input.onStatus(input.state().phase === "running" ? "waiting for current response" : "empty prompt ignored")
      return
    }

    if (isExit(text)) {
      input.onExit()
      return
    }

    area.setText("")
    setDraft("")
    scheduleRows()
    area.focus()
    queueMicrotask(() => {
      if (input.onSubmit(text)) {
        push(text)
        return
      }

      if (!area || area.isDestroyed) {
        return
      }

      area.setText(text)
      setDraft(text)
      area.cursorOffset = area.plainText.length
      syncRows()
      area.focus()
    })
  }

  onCleanup(() => {
    clear()
    if (area && !area.isDestroyed) {
      area.off("line-info-change", scheduleRows)
    }
  })

  createEffect(() => {
    input.width()
    if (input.prompt()) {
      scheduleRows()
    }
  })

  createEffect(() => {
    input.state().phase
    if (!input.prompt() || !area || area.isDestroyed || input.state().phase !== "idle") {
      return
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed) {
        return
      }

      area.focus()
    })
  })

  createEffect(() => {
    const type = input.view()
    if (type === prev) {
      return
    }

    if (prev === "prompt") {
      syncDraft()
    }

    clear()
    prev = type
    if (type !== "prompt") {
      return
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed) {
        return
      }

      if (area.plainText !== draft()) {
        area.setText(draft())
      }

      area.cursorOffset = area.plainText.length
      scheduleRows()
      area.focus()
    })
  })

  return {
    placeholder,
    bindings,
    onSubmit,
    onKeyDown,
    onContentChange: () => {
      syncDraft()
      scheduleRows()
    },
    bind,
  }
}
