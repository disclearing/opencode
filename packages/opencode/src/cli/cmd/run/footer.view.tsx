/** @jsxImportSource @opentui/solid */
import { StyledText, bg, fg, type KeyBinding } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import "opentui-spinner/solid"
import { Keybind } from "../../../util/keybind"
import { createColors, createFrames } from "../tui/ui/spinner"
import type { FooterKeybinds, FooterState } from "./types"
import { RUN_THEME_FALLBACK, type RunFooterTheme } from "./theme"

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
  visualCursor: {
    visualRow: number
  }
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
  theme?: RunFooterTheme
  keybinds: FooterKeybinds
  history?: string[]
  agent: string
  onSubmit: (text: string) => boolean
  onCycle: () => void
  onInterrupt: () => boolean
  onExitRequest?: () => boolean
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

  text = text.replace(/escape/g, "esc")

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
  const interrupts = createMemo(() => Keybind.parse(props.keybinds.interrupt))
  const historyPrevious = createMemo(() => Keybind.parse(props.keybinds.historyPrevious))
  const historyNext = createMemo(() => Keybind.parse(props.keybinds.historyNext))
  const variant = createMemo(() => printableBinding(props.keybinds.variantCycle, props.keybinds.leader))
  const interrupt = createMemo(() => printableBinding(props.keybinds.interrupt, props.keybinds.leader))
  const bindings = createMemo(() => textareaBindings(props.keybinds))
  const hints = createMemo(() => hintFlags(term().width))
  const busy = createMemo(() => props.state().phase === "running")
  const armed = createMemo(() => props.state().interrupt > 0)
  const exiting = createMemo(() => props.state().exit > 0)
  const queue = createMemo(() => props.state().queue)
  const duration = createMemo(() => props.state().duration)
  const usage = createMemo(() => props.state().usage)
  const interruptKey = createMemo(() => interrupt() || "/exit")
  const theme = createMemo(() => props.theme ?? RUN_THEME_FALLBACK.footer)
  const spin = createMemo(() => {
    const list = [theme().highlight, theme().text, theme().muted]
    return {
      frames: createFrames({
        colors: list,
        style: "blocks",
      }),
      color: createColors({
        colors: list,
        defaultColor: theme().muted,
        style: "blocks",
        enableFading: false,
      }),
    }
  })
  const placeholder = createMemo(() => {
    if (!props.state().first) {
      return ""
    }

    return new StyledText([bg(theme().surface)(fg(theme().muted)('Ask anything... "Fix a TODO in the codebase"'))])
  })

  const history: History = {
    items: (props.history ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item, index, all) => index === 0 || item !== all[index - 1])
      .slice(-200),
    index: null,
    draft: "",
  }

  let area: Area | undefined
  let leader = false
  let timeout: NodeJS.Timeout | undefined
  let rowsTick = false

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

  const scheduleRows = () => {
    if (rowsTick) {
      return
    }

    rowsTick = true
    queueMicrotask(() => {
      rowsTick = false
      syncRows()
    })
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
    if (event.ctrl && event.name === "c") {
      const handled = props.onExitRequest ? props.onExitRequest() : (props.onExit(), true)
      if (handled) {
        event.preventDefault()
      }
      return
    }

    if (match(interrupts(), toKeyInfo(event, false))) {
      if (props.onInterrupt()) {
        event.preventDefault()
        return
      }
    }

    if (handleCycle(event)) {
      return
    }

    const key = toKeyInfo(event, false)
    const previous = match(historyPrevious(), key)
    const next = match(historyNext(), key)

    if (!previous && !next) {
      return
    }

    if (!area || area.isDestroyed) {
      return
    }

    const dir = previous ? -1 : 1
    if ((dir === -1 && area.cursorOffset === 0) || (dir === 1 && area.cursorOffset === area.plainText.length)) {
      move(dir, event)
      return
    }

    if (dir === -1 && area.visualCursor.visualRow === 0) {
      area.cursorOffset = 0
    }

    const last =
      "height" in area && typeof area.height === "number" && Number.isFinite(area.height) && area.height > 0
        ? area.height - 1
        : Math.max(0, area.virtualLineCount - 1)
    if (dir === 1 && area.visualCursor.visualRow === last) {
      area.cursorOffset = area.plainText.length
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

    area.setText("")
    scheduleRows()
    area.focus()
    queueMicrotask(() => {
      if (props.onSubmit(text)) {
        push(text)
        return
      }

      if (!area || area.isDestroyed) {
        return
      }

      area.setText(text)
      area.cursorOffset = area.plainText.length
      syncRows()
      area.focus()
    })
  }

  onMount(() => {
    if (!area || area.isDestroyed) {
      return
    }

    area.on("line-info-change", scheduleRows)
    scheduleRows()
    area.focus()
  })

  onCleanup(() => {
    clearLeader()

    if (!area || area.isDestroyed) {
      return
    }

    area.off("line-info-change", scheduleRows)
  })

  createEffect(() => {
    term().width
    scheduleRows()
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
        borderColor={theme().highlight}
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
          backgroundColor={theme().surface}
          gap={0}
        >
          <textarea
            id="run-direct-footer-composer"
            width="100%"
            minHeight={TEXTAREA_MIN_ROWS}
            maxHeight={TEXTAREA_MAX_ROWS}
            wrapMode="word"
            placeholder={placeholder()}
            placeholderColor={theme().muted}
            textColor={theme().text}
            focusedTextColor={theme().text}
            backgroundColor={theme().surface}
            focusedBackgroundColor={theme().surface}
            cursorColor={theme().text}
            keyBindings={bindings()}
            onSubmit={onSubmit}
            onKeyDown={onKeyDown}
            onContentChange={scheduleRows}
            ref={(item) => {
              area = item as Area
            }}
          />

          <box id="run-direct-footer-meta-row" width="100%" flexDirection="row" gap={1} flexShrink={0} paddingTop={1}>
            <text id="run-direct-footer-agent" fg={theme().highlight} wrapMode="none" truncate flexShrink={0}>
              {props.agent}
            </text>
            <text id="run-direct-footer-model" fg={theme().muted} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
              {props.state().model}
            </text>
          </box>
        </box>
      </box>

      <box
        id="run-direct-footer-line-6"
        width="100%"
        height={1}
        border={["left"]}
        borderColor={theme().highlight}
        customBorderChars={{
          ...EMPTY_BORDER,
          vertical: "╹",
        }}
        flexShrink={0}
      >
        <box
          id="run-direct-footer-line-6-fill"
          width="100%"
          height={1}
          border={["bottom"]}
          borderColor={theme().line}
          customBorderChars={{
            ...EMPTY_BORDER,
            horizontal: "▀",
          }}
        />
      </box>

      <box
        id="run-direct-footer-row"
        width="100%"
        height={1}
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        flexShrink={0}
      >
        <Show when={busy() || exiting()}>
          <box id="run-direct-footer-hint-left" flexDirection="row" gap={1} flexShrink={0}>
            <Show when={exiting()}>
              <text id="run-direct-footer-hint-exit" fg={theme().highlight} wrapMode="none" truncate marginLeft={1}>
                Press Ctrl-c again to exit
              </text>
            </Show>

            <Show when={busy() && !exiting()}>
              <box id="run-direct-footer-status-spinner" marginLeft={1} flexShrink={0}>
                <spinner color={spin().color} frames={spin().frames} interval={40} />
              </box>

              <text
                id="run-direct-footer-hint-interrupt"
                fg={armed() ? theme().highlight : theme().text}
                wrapMode="none"
                truncate
              >
                {interruptKey()}{" "}
                <span style={{ fg: armed() ? theme().highlight : theme().muted }}>
                  {armed() ? "again to interrupt" : "interrupt"}
                </span>
              </text>
            </Show>
          </box>
        </Show>

        <Show when={!busy() && !exiting() && duration().length > 0}>
          <box id="run-direct-footer-duration" flexDirection="row" gap={2} flexShrink={0} marginLeft={1}>
            <text id="run-direct-footer-duration-mark" fg={theme().muted} wrapMode="none" truncate>
              ▣
            </text>
            <box id="run-direct-footer-duration-tail" flexDirection="row" gap={1} flexShrink={0}>
              <text id="run-direct-footer-duration-dot" fg={theme().muted} wrapMode="none" truncate>
                ·
              </text>
              <text id="run-direct-footer-duration-value" fg={theme().muted} wrapMode="none" truncate>
                {duration()}
              </text>
            </box>
          </box>
        </Show>

        <box id="run-direct-footer-spacer" flexGrow={1} flexShrink={1} backgroundColor="transparent" />

        <box id="run-direct-footer-hint-group" flexDirection="row" gap={2} flexShrink={0} justifyContent="flex-end">
          <Show when={queue() > 0}>
            <text id="run-direct-footer-queue" fg={theme().muted} wrapMode="none" truncate>
              {queue()} queued
            </text>
          </Show>
          <Show when={usage().length > 0}>
            <text id="run-direct-footer-usage" fg={theme().muted} wrapMode="none" truncate>
              {usage()}
            </text>
          </Show>
          <Show when={variant().length > 0 && hints().variant}>
            <text id="run-direct-footer-hint-variant" fg={theme().muted} wrapMode="none" truncate>
              {variant()} variant
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}
