/** @jsxImportSource @opentui/solid */
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js"
import path from "path"
import os from "os"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Locale } from "../../../util/locale"
import { toolDiffView, toolFiletype } from "./tool"
import type { RunFooterTheme } from "./theme"
import type { PermissionReply, RunDiffStyle } from "./types"

type Dict = Record<string, unknown>
type RejectArea = {
  isDestroyed: boolean
  plainText: string
  cursorOffset: number
  setText(text: string): void
  focus(): void
}

export type PermissionStage = "permission" | "always" | "reject"
export type PermissionOption = "once" | "always" | "reject" | "confirm" | "cancel"

export type PermissionBodyState = {
  requestID: string
  stage: PermissionStage
  selected: PermissionOption
  message: string
  submitting: boolean
}

export function createPermissionBodyState(requestID: string): PermissionBodyState {
  return {
    requestID,
    stage: "permission",
    selected: "once",
    message: "",
    submitting: false,
  }
}

export function permissionOptions(stage: PermissionStage): PermissionOption[] {
  if (stage === "permission") {
    return ["once", "always", "reject"]
  }

  if (stage === "always") {
    return ["confirm", "cancel"]
  }

  return []
}

function dict(v: unknown): Dict {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {}
  }

  return v as Dict
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const home = os.homedir()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }

  return absolute
}

function data(request: PermissionRequest): Dict {
  const meta = dict(request.metadata)
  return {
    ...meta,
    ...dict(meta.input),
  }
}

function patterns(request: PermissionRequest): string[] {
  return request.patterns.filter((item): item is string => typeof item === "string")
}

export function permissionInfo(request: PermissionRequest): {
  icon: string
  title: string
  lines: string[]
  diff?: string
  file?: string
} {
  const input = data(request)

  if (request.permission === "edit") {
    const file = text(input.filepath) || patterns(request)[0] || ""
    return {
      icon: "→",
      title: `Edit ${normalizePath(file)}`,
      lines: [],
      diff: text(input.diff),
      file,
    }
  }

  if (request.permission === "read") {
    const file = text(input.filePath) || patterns(request)[0] || ""
    return {
      icon: "→",
      title: `Read ${normalizePath(file)}`,
      lines: file ? [`Path: ${normalizePath(file)}`] : [],
    }
  }

  if (request.permission === "glob") {
    const pattern = text(input.pattern) || patterns(request)[0] || ""
    return {
      icon: "✱",
      title: `Glob "${pattern}"`,
      lines: pattern ? [`Pattern: ${pattern}`] : [],
    }
  }

  if (request.permission === "grep") {
    const pattern = text(input.pattern) || patterns(request)[0] || ""
    return {
      icon: "✱",
      title: `Grep "${pattern}"`,
      lines: pattern ? [`Pattern: ${pattern}`] : [],
    }
  }

  if (request.permission === "list") {
    const dir = text(input.path) || patterns(request)[0] || ""
    return {
      icon: "→",
      title: `List ${normalizePath(dir)}`,
      lines: dir ? [`Path: ${normalizePath(dir)}`] : [],
    }
  }

  if (request.permission === "bash") {
    const title = text(input.description) || "Shell command"
    const command = text(input.command)
    return {
      icon: "#",
      title,
      lines: command ? [`$ ${command}`] : patterns(request).map((item) => `- ${item}`),
    }
  }

  if (request.permission === "task") {
    const type = text(input.subagent_type) || "general"
    const desc = text(input.description)
    return {
      icon: "#",
      title: `${Locale.titlecase(type)} Task`,
      lines: desc ? [`◉ ${desc}`] : [],
    }
  }

  if (request.permission === "webfetch") {
    const url = text(input.url)
    return {
      icon: "%",
      title: `WebFetch ${url}`,
      lines: url ? [`URL: ${url}`] : [],
    }
  }

  if (request.permission === "websearch") {
    const query = text(input.query)
    return {
      icon: "◈",
      title: `Exa Web Search "${query}"`,
      lines: query ? [`Query: ${query}`] : [],
    }
  }

  if (request.permission === "codesearch") {
    const query = text(input.query)
    return {
      icon: "◇",
      title: `Exa Code Search "${query}"`,
      lines: query ? [`Query: ${query}`] : [],
    }
  }

  if (request.permission === "external_directory") {
    const meta = dict(request.metadata)
    const raw = text(meta.parentDir) || text(meta.filepath) || patterns(request)[0] || ""
    const dir = raw.includes("*") ? raw.slice(0, raw.indexOf("*")).replace(/[\\/]+$/, "") : raw
    return {
      icon: "←",
      title: `Access external directory ${normalizePath(dir)}`,
      lines: patterns(request).map((item) => `- ${item}`),
    }
  }

  if (request.permission === "doom_loop") {
    return {
      icon: "⟳",
      title: "Continue after repeated failures",
      lines: ["This keeps the session running despite repeated failures."],
    }
  }

  return {
    icon: "⚙",
    title: `Call tool ${request.permission}`,
    lines: [`Tool: ${request.permission}`],
  }
}

function alwaysLines(request: PermissionRequest): string[] {
  if (request.always.length === 1 && request.always[0] === "*") {
    return [`This will allow ${request.permission} until OpenCode is restarted.`]
  }

  return [
    "This will allow the following patterns until OpenCode is restarted.",
    ...request.always.map((item) => `- ${item}`),
  ]
}

function label(option: PermissionOption): string {
  if (option === "once") return "Allow once"
  if (option === "always") return "Allow always"
  if (option === "reject") return "Reject"
  if (option === "confirm") return "Confirm"
  return "Cancel"
}

function buttons(
  list: PermissionOption[],
  selected: PermissionOption,
  theme: RunFooterTheme,
  disabled: boolean,
  onHover: (option: PermissionOption) => void,
  onSelect: (option: PermissionOption) => void,
) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <For each={list}>
        {(option) => (
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={option === selected ? theme.highlight : theme.line}
            onMouseOver={() => {
              if (!disabled) onHover(option)
            }}
            onMouseUp={() => {
              if (!disabled) onSelect(option)
            }}
          >
            <text fg={option === selected ? theme.surface : theme.muted}>{label(option)}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function RejectField(props: {
  theme: RunFooterTheme
  text: string
  disabled: boolean
  onChange: (text: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  let area: RejectArea | undefined

  createEffect(() => {
    if (!area || area.isDestroyed) {
      return
    }

    if (area.plainText !== props.text) {
      area.setText(props.text)
      area.cursorOffset = props.text.length
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed || props.disabled) {
        return
      }
      area.focus()
    })
  })

  return (
    <textarea
      id="run-direct-footer-permission-reject"
      width="100%"
      minHeight={1}
      maxHeight={3}
      wrapMode="word"
      placeholder="Tell OpenCode what to do differently"
      placeholderColor={props.theme.muted}
      textColor={props.theme.text}
      focusedTextColor={props.theme.text}
      backgroundColor={props.theme.surface}
      focusedBackgroundColor={props.theme.surface}
      cursorColor={props.theme.text}
      focused={!props.disabled}
      onContentChange={() => {
        if (!area || area.isDestroyed) {
          return
        }
        props.onChange(area.plainText)
      }}
      onKeyDown={(event) => {
        if (event.name === "escape") {
          event.preventDefault()
          props.onCancel()
          return
        }

        if (event.name === "return" && !event.meta && !event.ctrl && !event.shift) {
          event.preventDefault()
          props.onConfirm()
        }
      }}
      ref={(item) => {
        area = item as RejectArea
      }}
    />
  )
}

export function RunPermissionBody(props: {
  request: PermissionRequest
  theme: RunFooterTheme
  diffStyle?: RunDiffStyle
  onReply?: (input: PermissionReply) => void | Promise<void>
  onStatus: (text: string) => void
}) {
  const dims = useTerminalDimensions()
  const [state, setState] = createSignal(createPermissionBodyState(props.request.id))
  const info = createMemo(() => permissionInfo(props.request))
  const view = createMemo(() => toolDiffView(dims().width, props.diffStyle))
  const opts = createMemo(() => permissionOptions(state().stage))
  const busy = createMemo(() => state().submitting)

  createEffect(() => {
    const id = props.request.id
    if (state().requestID === id) {
      return
    }

    setState(createPermissionBodyState(id))
  })

  const shift = (dir: -1 | 1) => {
    const list = permissionOptions(state().stage)
    if (list.length === 0) {
      return
    }

    const idx = Math.max(0, list.indexOf(state().selected))
    const next = list[(idx + dir + list.length) % list.length]
    setState((prev) => ({
      ...prev,
      selected: next,
    }))
  }

  const submit = async (next: PermissionReply) => {
    if (!props.onReply) {
      props.onStatus("permission queue unavailable")
      return
    }

    setState((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onReply(next)
    } catch {
      setState((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const run = (option: PermissionOption) => {
    const cur = state()
    if (cur.submitting) {
      return
    }

    if (cur.stage === "permission") {
      if (option === "always") {
        setState((prev) => ({
          ...prev,
          stage: "always",
          selected: "confirm",
        }))
        return
      }

      if (option === "reject") {
        setState((prev) => ({
          ...prev,
          stage: "reject",
          selected: "reject",
        }))
        return
      }

      void submit(permissionReply(props.request.id, "once"))
      return
    }

    if (cur.stage !== "always") {
      return
    }

    if (option === "cancel") {
      setState((prev) => ({
        ...prev,
        stage: "permission",
        selected: "always",
      }))
      return
    }

    void submit(permissionReply(props.request.id, "always"))
  }

  const reject = () => {
    if (state().submitting) {
      return
    }

    void submit(permissionReply(props.request.id, "reject", state().message))
  }

  const cancelReject = () => {
    setState((prev) => ({
      ...prev,
      stage: "permission",
      selected: "reject",
    }))
  }

  useKeyboard((event) => {
    const cur = state()
    if (cur.stage === "reject") {
      return
    }

    if (cur.submitting) {
      if (["left", "right", "h", "l", "return", "escape"].includes(event.name)) {
        event.preventDefault()
      }
      return
    }

    if (event.name === "left" || event.name === "h") {
      shift(-1)
      event.preventDefault()
      return
    }

    if (event.name === "right" || event.name === "l") {
      shift(1)
      event.preventDefault()
      return
    }

    if (event.name === "return") {
      run(state().selected)
      event.preventDefault()
      return
    }

    if (event.name !== "escape") {
      return
    }

    if (cur.stage === "always") {
      setState((prev) => ({
        ...prev,
        stage: "permission",
        selected: "always",
      }))
      event.preventDefault()
      return
    }

    setState((prev) => ({
      ...prev,
      stage: "reject",
      selected: "reject",
    }))
    event.preventDefault()
  })

  return (
    <box id="run-direct-footer-permission-body" width="100%" height="100%" flexDirection="column" gap={1}>
      <box flexDirection="column" gap={0} flexShrink={0}>
        <box flexDirection="row" gap={1}>
          <text fg={props.theme.highlight}>△</text>
          <text fg={props.theme.text}>
            <Switch>
              <Match when={state().stage === "always"}>Always allow</Match>
              <Match when={state().stage === "reject"}>Reject permission</Match>
              <Match when={true}>Permission required</Match>
            </Switch>
          </text>
        </box>
        <Show when={state().stage === "permission"}>
          <box flexDirection="row" gap={1} paddingLeft={2}>
            <text fg={props.theme.muted}>{info().icon}</text>
            <text fg={props.theme.text} wrapMode="word">
              {info().title}
            </text>
          </box>
        </Show>
      </box>

      <box width="100%" flexGrow={1} flexShrink={1}>
        <Switch>
          <Match when={state().stage === "permission"}>
            <scrollbox
              width="100%"
              height="100%"
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: props.theme.surface,
                  foregroundColor: props.theme.line,
                },
              }}
            >
              <box width="100%" flexDirection="column" gap={1}>
                <Show
                  when={info().diff}
                  fallback={<For each={info().lines}>{(line) => <text fg={props.theme.text}>{line}</text>}</For>}
                >
                  <diff
                    diff={info().diff!}
                    view={view()}
                    filetype={toolFiletype(info().file)}
                    showLineNumbers={true}
                    width="100%"
                    wrapMode="word"
                    fg={props.theme.text}
                    lineNumberFg={props.theme.muted}
                  />
                </Show>
                <Show when={!info().diff && info().lines.length === 0}>
                  <text fg={props.theme.muted}>No diff provided</text>
                </Show>
              </box>
            </scrollbox>
          </Match>
          <Match when={state().stage === "always"}>
            <scrollbox
              width="100%"
              height="100%"
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: props.theme.surface,
                  foregroundColor: props.theme.line,
                },
              }}
            >
              <box width="100%" flexDirection="column" gap={1}>
                <For each={alwaysLines(props.request)}>{(line) => <text fg={props.theme.text}>{line}</text>}</For>
              </box>
            </scrollbox>
          </Match>
          <Match when={state().stage === "reject"}>
            <box width="100%" height="100%" flexDirection="column" gap={1}>
              <text fg={props.theme.muted}>Tell OpenCode what to do differently</text>
              <RejectField
                theme={props.theme}
                text={state().message}
                disabled={busy()}
                onChange={(text) => {
                  setState((prev) => ({
                    ...prev,
                    message: text,
                  }))
                }}
                onConfirm={reject}
                onCancel={cancelReject}
              />
            </box>
          </Match>
        </Switch>
      </box>

      <Switch>
        <Match when={state().stage !== "reject"}>
          <box flexDirection="column" gap={1} flexShrink={0}>
            {buttons(
              opts(),
              state().selected,
              props.theme,
              busy(),
              (option) => {
                setState((prev) => ({
                  ...prev,
                  selected: option,
                }))
              },
              run,
            )}
            <text fg={props.theme.muted} wrapMode="word">
              <Show
                when={busy()}
                fallback={
                  state().stage === "always"
                    ? "⇆ select   enter confirm   esc cancel"
                    : "⇆ select   enter confirm   esc reject"
                }
              >
                Waiting for permission event...
              </Show>
            </text>
          </box>
        </Match>
        <Match when={true}>
          <text fg={props.theme.muted} wrapMode="word" flexShrink={0}>
            <Show when={busy()} fallback="enter confirm   esc cancel">
              Waiting for permission event...
            </Show>
          </text>
        </Match>
      </Switch>
    </box>
  )
}

export function permissionReply(requestID: string, reply: PermissionReply["reply"], message?: string): PermissionReply {
  return {
    requestID,
    reply,
    ...(message && message.trim() ? { message: message.trim() } : {}),
  }
}
