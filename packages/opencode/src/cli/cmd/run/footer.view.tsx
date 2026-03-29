/** @jsxImportSource @opentui/solid */
import type { KeyBinding } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { Keybind } from "../../../util/keybind"
import type { FooterKeybinds, FooterState } from "./types"

const HIGHLIGHT_COLOR = "#38bdf8"
const MUTED_COLOR = "#64748b"
const TEXT_COLOR = "#f8fafc"
const BORDER_COLOR = "#334155"

const LEADER_TIMEOUT_MS = 2000

export const TEXTAREA_MIN_ROWS = 1
export const TEXTAREA_MAX_ROWS = 6

export const HINT_BREAKPOINTS = {
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

type History = {
  items: string[]
  index: number | null
  draft: string
}

type Area = {
  isDestroyed: boolean
  virtualLineCount: number
  plainText: string
  cursorOffset: number
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

type RunFooterViewProps = {
  state: () => FooterState
  keybinds: FooterKeybinds
  agent: string
  onSubmit: (text: string) => boolean
  onCycle: () => void
  onExit: () => void
  onRows: (rows: number) => void
  onStatus: (text: string) => void
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

function textareaBindings(keybinds: FooterKeybinds): KeyBinding[] {
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
  const lead = Keybind.parse(leader).at(0)
  if (lead) {
    text = text.replace("<leader>", Keybind.toString(lead))
  }

  return text
}

function toKeyInfo(event: Key, leader: boolean): Keybind.Info {
  return {
    name: event.name === " " ? "space" : event.name,
    ctrl: !!event.ctrl,
    meta: !!event.meta,
    shift: !!event.shift,
    super: !!event.super,
    leader,
  }
}

function match(bindings: Keybind.Info[], event: Keybind.Info): boolean {
  return bindings.some((item) => Keybind.match(item, event))
}

function clampRows(rows: number): number {
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

export function RunFooterView(props: RunFooterViewProps) {
  const term = useTerminalDimensions()
  const leaders = createMemo(() => Keybind.parse(props.keybinds.leader))
  const cycles = createMemo(() => Keybind.parse(props.keybinds.variantCycle))
  const variant = createMemo(() => printableBinding(props.keybinds.variantCycle, props.keybinds.leader))
  const bindings = createMemo(() => textareaBindings(props.keybinds))
  const hints = createMemo(() => hintFlags(term().width))
  const busy = createMemo(() => props.state().phase === "running")
  const status = createMemo(() => {
    const state = props.state()
    const base = state.status || `${props.agent} · ${state.model}`
    const queued = state.queue > 0 ? ` · ${state.queue} queued` : ""
    return `${base}${queued}`
  })

  const history: History = {
    items: [],
    index: null,
    draft: "",
  }

  let area: Area | undefined
  let leader = false
  let timeout: NodeJS.Timeout | undefined

  const clearLeader = () => {
    leader = false
    if (!timeout) {
      return
    }
    clearTimeout(timeout)
    timeout = undefined
  }

  const armLeader = () => {
    clearLeader()
    leader = true
    timeout = setTimeout(() => {
      clearLeader()
    }, LEADER_TIMEOUT_MS)
  }

  const syncRows = () => {
    if (!area || area.isDestroyed) {
      return
    }

    props.onRows(clampRows(area.virtualLineCount || 1))
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
      const next = history.index + dir
      if (next < 0) {
        return
      }

      if (next >= history.items.length) {
        history.index = null
        area.setText(history.draft)
        area.cursorOffset = area.plainText.length
        event.preventDefault()
        syncRows()
        return
      }

      history.index = next
    }

    const next = history.items[history.index]
    area.setText(next)
    area.cursorOffset = dir === -1 ? 0 : area.plainText.length
    event.preventDefault()
    syncRows()
  }

  const handleCycle = (event: Key): boolean => {
    const plain = toKeyInfo(event, false)

    if (!leader && match(leaders(), plain)) {
      armLeader()
      event.preventDefault()
      return true
    }

    if (leader) {
      const key = toKeyInfo(event, true)
      const hit = match(cycles(), key)
      clearLeader()
      event.preventDefault()

      if (hit) {
        props.onCycle()
      }

      return true
    }

    if (!match(cycles(), plain)) {
      return false
    }

    props.onCycle()
    event.preventDefault()
    return true
  }

  const onKeyDown = (event: Key) => {
    if (handleCycle(event)) {
      return
    }

    if (event.ctrl || event.meta || event.shift || event.super || event.hyper) {
      return
    }

    if (event.name === "up") {
      move(-1, event)
      return
    }

    if (event.name === "down") {
      move(1, event)
    }
  }

  const onSubmit = () => {
    if (!area || area.isDestroyed) {
      return
    }

    const text = area.plainText.trim()
    if (!text) {
      props.onStatus(props.state().phase === "running" ? "waiting for current response" : "empty prompt ignored")
      return
    }

    if (isExitCommand(text)) {
      props.onExit()
      return
    }

    if (!props.onSubmit(text)) {
      return
    }

    push(text)
    area.setText("")
    syncRows()
    area.focus()
  }

  const onLineInfoChange = () => {
    syncRows()
  }

  onMount(() => {
    if (!area || area.isDestroyed) {
      return
    }

    area.on("line-info-change", onLineInfoChange)
    syncRows()
    area.focus()
  })

  onCleanup(() => {
    clearLeader()
    if (!area || area.isDestroyed) {
      return
    }

    area.off("line-info-change", onLineInfoChange)
  })

  createEffect(() => {
    term().width
    queueMicrotask(syncRows)
  })

  createEffect(() => {
    props.state().phase
    if (!area || area.isDestroyed || props.state().phase !== "idle") {
      return
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed) {
        return
      }
      area.focus()
    })
  })

  return (
    <box
      id="run-direct-footer-shell"
      width="100%"
      height="100%"
      border={false}
      backgroundColor="transparent"
      flexDirection="column"
      gap={0}
      padding={0}
    >
      <box
        id="run-direct-footer-composer-frame"
        width="100%"
        flexShrink={0}
        border={["left"]}
        borderColor={HIGHLIGHT_COLOR}
        customBorderChars={{
          ...EMPTY_BORDER,
          vertical: "┃",
          bottomLeft: "╹",
        }}
      >
        <box
          id="run-direct-footer-composer-area"
          width="100%"
          flexGrow={1}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          flexDirection="column"
          backgroundColor="transparent"
          gap={0}
        >
          <box id="run-direct-footer-status-row" width="100%" height={1} flexDirection="row" gap={1} flexShrink={0}>
            <Show when={busy()}>
              <text id="run-direct-footer-status-spinner" fg={HIGHLIGHT_COLOR} wrapMode="none" truncate>
                [⋯]
              </text>
            </Show>
            <text
              id="run-direct-footer-status-text"
              fg={busy() ? HIGHLIGHT_COLOR : MUTED_COLOR}
              wrapMode="none"
              truncate
              flexGrow={1}
              flexShrink={1}
            >
              {status()}
            </text>
          </box>

          <textarea
            id="run-direct-footer-composer"
            width="100%"
            minHeight={TEXTAREA_MIN_ROWS}
            maxHeight={TEXTAREA_MAX_ROWS}
            wrapMode="word"
            placeholder={'Ask anything... "Fix a TODO in the codebase"'}
            placeholderColor={MUTED_COLOR}
            textColor={TEXT_COLOR}
            focusedTextColor={TEXT_COLOR}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            cursorColor={TEXT_COLOR}
            keyBindings={bindings()}
            onSubmit={onSubmit}
            onKeyDown={onKeyDown}
            onContentChange={syncRows}
            ref={(item) => {
              area = item as Area
            }}
          />

          <box id="run-direct-footer-meta-row" width="100%" flexDirection="row" gap={1} paddingTop={1} flexShrink={0}>
            <text id="run-direct-footer-agent" fg={HIGHLIGHT_COLOR} wrapMode="none" truncate flexShrink={0}>
              {props.agent}
            </text>
            <text id="run-direct-footer-model" fg={MUTED_COLOR} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
              {props.state().model}
            </text>
          </box>
        </box>
      </box>

      <box
        id="run-direct-footer-separator-row"
        width="100%"
        height={1}
        border={["left"]}
        borderColor={HIGHLIGHT_COLOR}
        customBorderChars={{
          ...EMPTY_BORDER,
          vertical: "╹",
        }}
      >
        <box
          id="run-direct-footer-separator-line"
          width="100%"
          height={1}
          border={["bottom"]}
          borderColor={BORDER_COLOR}
          customBorderChars={{
            ...EMPTY_BORDER,
            horizontal: "─",
          }}
        />
      </box>

      <box
        id="run-direct-footer-row"
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        flexShrink={0}
      >
        <Show when={props.state().queue > 0}>
          <text id="run-direct-footer-queued" fg={MUTED_COLOR} wrapMode="none" truncate>
            {props.state().queue} queued
          </text>
        </Show>

        <box id="run-direct-footer-spacer" flexGrow={1} flexShrink={1} backgroundColor="transparent" />

        <box id="run-direct-footer-hint-group" flexDirection="row" gap={2} flexShrink={0} justifyContent="flex-end">
          <Show
            when={busy()}
            fallback={
              <>
                <Show when={hints().send}>
                  <text id="run-direct-footer-hint-send" fg={TEXT_COLOR} wrapMode="none" truncate>
                    Enter send
                  </text>
                </Show>
                <Show when={hints().newline}>
                  <text id="run-direct-footer-hint-newline" fg={MUTED_COLOR} wrapMode="none" truncate>
                    Shift+Enter newline
                  </text>
                </Show>
                <Show when={hints().history}>
                  <text id="run-direct-footer-hint-history" fg={MUTED_COLOR} wrapMode="none" truncate>
                    Up/Down history
                  </text>
                </Show>
                <Show when={variant().length > 0 && hints().variant}>
                  <text id="run-direct-footer-hint-variant" fg={MUTED_COLOR} wrapMode="none" truncate>
                    {variant()} variant
                  </text>
                </Show>
                <text id="run-direct-footer-hint-exit" fg={MUTED_COLOR} wrapMode="none" truncate>
                  /exit
                </text>
              </>
            }
          >
            <text id="run-direct-footer-hint-exit-running" fg={TEXT_COLOR} wrapMode="none" truncate>
              /exit quit
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}
