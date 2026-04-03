/** @jsxImportSource @opentui/solid */
import { StyledText, bg, fg, type KeyBinding } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import "opentui-spinner/solid"
import { Keybind } from "../../../util/keybind"
import { createColors, createFrames } from "../tui/ui/spinner"
import {
  RunPermissionBody,
  createPermissionBodyState,
  permissionOptions,
  permissionReply,
  type PermissionBodyState,
  type PermissionOption,
} from "./footer.permission"
import {
  RunQuestionBody,
  createQuestionBodyState,
  questionAnswers,
  questionConfirm,
  questionCustom,
  questionInfo,
  questionInput,
  questionOther,
  questionPicked,
  questionSingle,
  questionTabs,
  questionTotal,
  type QuestionBodyState,
} from "./footer.question"
import type {
  FooterKeybinds,
  FooterState,
  FooterView,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunDiffStyle,
} from "./types"
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
  view?: () => FooterView
  theme?: RunFooterTheme
  diffStyle?: RunDiffStyle
  keybinds: FooterKeybinds
  history?: string[]
  agent: string
  onSubmit: (text: string) => boolean
  onPermissionReply?: (input: PermissionReply) => void | Promise<void>
  onQuestionReply?: (input: QuestionReply) => void | Promise<void>
  onQuestionReject?: (input: QuestionReject) => void | Promise<void>
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

function RunPromptBody(props: {
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

function RunBodyShell(props: {
  id: string
  theme: () => RunFooterTheme
  title: string
  lines: string[]
  hint: string
}) {
  return (
    <box id={props.id} width="100%" height="100%" flexDirection="column" gap={1}>
      <scrollbox
        id={`${props.id}-scroll`}
        width="100%"
        height="100%"
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: props.theme().surface,
            foregroundColor: props.theme().line,
          },
        }}
      >
        <box width="100%" flexDirection="column" gap={1}>
          <text id={`${props.id}-title`} fg={props.theme().highlight} wrapMode="word">
            {props.title}
          </text>
          <For each={props.lines}>
            {(line) => (
              <text fg={props.theme().text} wrapMode="word">
                {line}
              </text>
            )}
          </For>
        </box>
      </scrollbox>
      <text id={`${props.id}-hint`} fg={props.theme().muted} wrapMode="word">
        {props.hint}
      </text>
    </box>
  )
}

export function RunFooterView(props: RunFooterViewProps) {
  const term = useTerminalDimensions()
  const active = createMemo<FooterView>(() => props.view?.() ?? { type: "prompt" })
  const promptView = createMemo(() => active().type === "prompt")
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
  const [draft, setDraft] = createSignal("")
  const [permission, setPermission] = createSignal<PermissionBodyState>(createPermissionBodyState(""))
  const [question, setQuestion] = createSignal<QuestionBodyState>(createQuestionBodyState(""))
  const permissionView = createMemo<Extract<FooterView, { type: "permission" }> | undefined>(() => {
    const view = active()
    return view.type === "permission" ? view : undefined
  })
  const questionView = createMemo<Extract<FooterView, { type: "question" }> | undefined>(() => {
    const view = active()
    return view.type === "question" ? view : undefined
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
  let prev = active().type

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

  const bindArea = (next?: Area) => {
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
      if (!area || area.isDestroyed || !promptView()) {
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

  const shiftPermission = (dir: -1 | 1) => {
    const state = permission()
    const opts = permissionOptions(state.stage)
    if (opts.length === 0) {
      return
    }

    const index = Math.max(0, opts.indexOf(state.selected))
    const next = opts[(index + dir + opts.length) % opts.length]
    setPermission((prev) => ({
      ...prev,
      selected: next,
    }))
  }

  const beginPermissionReply = async (next: PermissionReply) => {
    if (!props.onPermissionReply) {
      props.onStatus("permission queue unavailable")
      return
    }

    setPermission((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onPermissionReply(next)
    } catch {
      setPermission((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const runPermission = (option: PermissionOption) => {
    const view = permissionView()
    const state = permission()
    if (!view || state.submitting) {
      return
    }

    if (state.stage === "permission") {
      if (option === "always") {
        setPermission((prev) => ({
          ...prev,
          stage: "always",
          selected: "confirm",
        }))
        return
      }

      if (option === "reject") {
        setPermission((prev) => ({
          ...prev,
          stage: "reject",
          selected: "reject",
        }))
        return
      }

      void beginPermissionReply(permissionReply(view.request.id, "once"))
      return
    }

    if (state.stage === "always") {
      if (option === "cancel") {
        setPermission((prev) => ({
          ...prev,
          stage: "permission",
          selected: "always",
        }))
        return
      }

      void beginPermissionReply(permissionReply(view.request.id, "always"))
    }
  }

  const handlePermissionKey = (event: Key): boolean => {
    const state = permission()
    if (!permissionView()) {
      return false
    }

    if (state.stage === "reject") {
      return false
    }

    if (state.submitting) {
      if (["left", "right", "h", "l", "return", "escape"].includes(event.name)) {
        event.preventDefault()
        return true
      }
      return false
    }

    if (event.name === "left" || event.name === "h") {
      shiftPermission(-1)
      event.preventDefault()
      return true
    }

    if (event.name === "right" || event.name === "l") {
      shiftPermission(1)
      event.preventDefault()
      return true
    }

    if (event.name === "return") {
      runPermission(permission().selected)
      event.preventDefault()
      return true
    }

    if (event.name !== "escape") {
      return false
    }

    if (state.stage === "always") {
      setPermission((prev) => ({
        ...prev,
        stage: "permission",
        selected: "always",
      }))
      event.preventDefault()
      return true
    }

    setPermission((prev) => ({
      ...prev,
      stage: "reject",
      selected: "reject",
    }))
    event.preventDefault()
    return true
  }

  const onPermissionHover = (option: PermissionOption) => {
    setPermission((prev) => ({
      ...prev,
      selected: option,
    }))
  }

  const onPermissionMessage = (text: string) => {
    setPermission((prev) => ({
      ...prev,
      message: text,
    }))
  }

  const onPermissionReject = () => {
    const view = permissionView()
    if (!view || permission().submitting) {
      return
    }

    void beginPermissionReply(permissionReply(view.request.id, "reject", permission().message))
  }

  const onPermissionCancel = () => {
    setPermission((prev) => ({
      ...prev,
      stage: "permission",
      selected: "reject",
    }))
  }

  const setQuestionTab = (tab: number) => {
    setQuestion((prev) => ({
      ...prev,
      tab,
      selected: 0,
      editing: false,
    }))
  }

  const moveQuestion = (dir: -1 | 1) => {
    const view = questionView()
    if (!view) {
      return
    }

    const total = questionTotal(view.request, question())
    if (total === 0) {
      return
    }

    setQuestion((prev) => ({
      ...prev,
      selected: (prev.selected + dir + total) % total,
    }))
  }

  const beginQuestionReply = async (input: QuestionReply) => {
    if (!props.onQuestionReply) {
      props.onStatus("question queue unavailable")
      return
    }

    setQuestion((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onQuestionReply(input)
    } catch {
      setQuestion((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const beginQuestionReject = async (input: QuestionReject) => {
    if (!props.onQuestionReject) {
      props.onStatus("question queue unavailable")
      return
    }

    setQuestion((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onQuestionReject(input)
    } catch {
      setQuestion((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const storeQuestion = (tab: number, list: string[]) => {
    setQuestion((prev) => {
      const answers = [...prev.answers]
      answers[tab] = list
      return {
        ...prev,
        answers,
      }
    })
  }

  const storeCustom = (tab: number, text: string) => {
    setQuestion((prev) => {
      const custom = [...prev.custom]
      custom[tab] = text
      return {
        ...prev,
        custom,
      }
    })
  }

  const pickQuestion = (answer: string, custom = false) => {
    const view = questionView()
    if (!view) {
      return
    }

    const state = question()
    const answers = [...state.answers]
    answers[state.tab] = [answer]
    const next = {
      ...state,
      answers,
      editing: false,
    }
    if (custom) {
      const list = [...state.custom]
      list[state.tab] = answer
      next.custom = list
    }
    setQuestion(next)

    if (questionSingle(view.request)) {
      void beginQuestionReply({
        requestID: view.request.id,
        answers: [[answer]],
      })
      return
    }

    setQuestionTab(state.tab + 1)
  }

  const toggleQuestion = (answer: string) => {
    const state = question()
    const list = [...(state.answers[state.tab] ?? [])]
    const index = list.indexOf(answer)
    if (index === -1) {
      list.push(answer)
    } else {
      list.splice(index, 1)
    }
    storeQuestion(state.tab, list)
  }

  const saveQuestionCustom = () => {
    const view = questionView()
    if (!view) {
      return
    }

    const state = question()
    const info = questionInfo(view.request, state)
    if (!info) {
      return
    }

    const text = questionInput(state).trim()
    const prev = state.custom[state.tab]
    if (!text) {
      if (prev) {
        storeCustom(state.tab, "")
        storeQuestion(
          state.tab,
          (state.answers[state.tab] ?? []).filter((item) => item !== prev),
        )
      }
      setQuestion((prev) => ({
        ...prev,
        editing: false,
      }))
      return
    }

    if (info.multiple) {
      const answers = [...(state.answers[state.tab] ?? [])]
      if (prev) {
        const index = answers.indexOf(prev)
        if (index !== -1) {
          answers.splice(index, 1)
        }
      }
      if (!answers.includes(text)) {
        answers.push(text)
      }
      storeCustom(state.tab, text)
      storeQuestion(state.tab, answers)
      setQuestion((prev) => ({
        ...prev,
        editing: false,
      }))
      return
    }

    pickQuestion(text, true)
  }

  const selectQuestion = () => {
    const view = questionView()
    if (!view) {
      return
    }

    const state = question()
    const info = questionInfo(view.request, state)
    if (!info) {
      return
    }

    if (questionOther(view.request, state)) {
      if (!info.multiple) {
        setQuestion((prev) => ({
          ...prev,
          editing: true,
        }))
        return
      }

      const value = questionInput(state)
      if (value && questionPicked(state)) {
        toggleQuestion(value)
        return
      }

      setQuestion((prev) => ({
        ...prev,
        editing: true,
      }))
      return
    }

    const option = info.options[state.selected]
    if (!option) {
      return
    }

    if (info.multiple) {
      toggleQuestion(option.label)
      return
    }

    pickQuestion(option.label)
  }

  const submitQuestion = () => {
    const view = questionView()
    if (!view) {
      return
    }

    void beginQuestionReply({
      requestID: view.request.id,
      answers: questionAnswers(question(), view.request.questions.length),
    })
  }

  const rejectQuestion = () => {
    const view = questionView()
    if (!view) {
      return
    }

    void beginQuestionReject({
      requestID: view.request.id,
    })
  }

  const handleQuestionKey = (event: Key): boolean => {
    const view = questionView()
    if (!view) {
      return false
    }

    const state = question()
    if (state.submitting) {
      event.preventDefault()
      return true
    }

    if (state.editing) {
      if (event.name === "escape") {
        setQuestion((prev) => ({
          ...prev,
          editing: false,
        }))
        event.preventDefault()
        return true
      }

      if (event.name === "return" && !event.shift && !event.ctrl && !event.meta) {
        saveQuestionCustom()
        event.preventDefault()
        return true
      }

      return false
    }

    if (!questionSingle(view.request) && (event.name === "left" || event.name === "h")) {
      setQuestionTab((state.tab - 1 + questionTabs(view.request)) % questionTabs(view.request))
      event.preventDefault()
      return true
    }

    if (!questionSingle(view.request) && (event.name === "right" || event.name === "l")) {
      setQuestionTab((state.tab + 1) % questionTabs(view.request))
      event.preventDefault()
      return true
    }

    if (!questionSingle(view.request) && event.name === "tab") {
      const dir = event.shift ? -1 : 1
      setQuestionTab((state.tab + dir + questionTabs(view.request)) % questionTabs(view.request))
      event.preventDefault()
      return true
    }

    if (questionConfirm(view.request, state)) {
      if (event.name === "return") {
        submitQuestion()
        event.preventDefault()
        return true
      }

      if (event.name === "escape") {
        rejectQuestion()
        event.preventDefault()
        return true
      }

      return false
    }

    const total = questionTotal(view.request, state)
    const max = Math.min(total, 9)
    const digit = Number(event.name)
    if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
      setQuestion((prev) => ({
        ...prev,
        selected: digit - 1,
      }))
      selectQuestion()
      event.preventDefault()
      return true
    }

    if (event.name === "up" || event.name === "k") {
      moveQuestion(-1)
      event.preventDefault()
      return true
    }

    if (event.name === "down" || event.name === "j") {
      moveQuestion(1)
      event.preventDefault()
      return true
    }

    if (event.name === "return") {
      selectQuestion()
      event.preventDefault()
      return true
    }

    if (event.name === "escape") {
      rejectQuestion()
      event.preventDefault()
      return true
    }

    return false
  }

  const onQuestionTab = (tab: number) => {
    if (question().submitting) {
      return
    }

    setQuestionTab(tab)
  }

  const onQuestionMove = (index: number) => {
    if (question().submitting) {
      return
    }

    setQuestion((prev) => ({
      ...prev,
      selected: index,
    }))
  }

  const onQuestionOption = (index: number) => {
    if (question().submitting) {
      return
    }

    setQuestion((prev) => ({
      ...prev,
      selected: index,
    }))
    selectQuestion()
  }

  const onQuestionCustom = (text: string) => {
    if (question().submitting) {
      return
    }

    storeCustom(question().tab, text)
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

  useKeyboard((event) => {
    if (promptView()) {
      return
    }

    if (event.ctrl && event.name === "c") {
      const handled = props.onExitRequest ? props.onExitRequest() : (props.onExit(), true)
      if (handled) {
        event.preventDefault()
      }
      return
    }

    if (permissionView()) {
      if (handlePermissionKey(event)) {
        return
      }

      if (permission().stage === "reject") {
        return
      }

      return
    }

    if (questionView()) {
      handleQuestionKey(event)
      return
    }

    const key = toKeyInfo(event, false)
    if (leader || match(leaders(), key)) {
      clearLeader()
      event.preventDefault()
      return
    }

    if (match(cycles(), key) || match(historyPrevious(), key) || match(historyNext(), key)) {
      event.preventDefault()
      return
    }

    if (["escape", "tab", "return", "up", "down", "left", "right"].includes(event.name)) {
      event.preventDefault()
    }
  })

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
    setDraft("")
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
      setDraft(text)
      area.cursorOffset = area.plainText.length
      syncRows()
      area.focus()
    })
  }

  onCleanup(() => {
    clearLeader()

    if (area && !area.isDestroyed) {
      area.off("line-info-change", scheduleRows)
    }
  })

  createEffect(() => {
    term().width
    if (promptView()) {
      scheduleRows()
    }
  })

  createEffect(() => {
    props.state().phase
    if (!promptView() || !area || area.isDestroyed || props.state().phase !== "idle") {
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
    const type = active().type
    if (type === prev) {
      return
    }

    if (prev === "prompt") {
      syncDraft()
    }

    clearLeader()
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

  createEffect(() => {
    const view = permissionView()
    if (!view) {
      return
    }

    if (permission().requestID === view.request.id) {
      return
    }

    setPermission(createPermissionBodyState(view.request.id))
  })

  createEffect(() => {
    const view = questionView()
    if (!view) {
      return
    }

    if (question().requestID === view.request.id) {
      return
    }

    setQuestion(createQuestionBodyState(view.request.id))
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
      <box id="run-direct-footer-top-spacer" width="100%" height={1} flexShrink={0} backgroundColor="transparent" />

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
          <box id="run-direct-footer-body" width="100%" flexGrow={1} flexShrink={1} flexDirection="column">
            <Switch>
              <Match when={active().type === "prompt"}>
                <RunPromptBody
                  theme={theme}
                  placeholder={placeholder}
                  bindings={bindings}
                  onSubmit={onSubmit}
                  onKeyDown={onKeyDown}
                  onContentChange={() => {
                    syncDraft()
                    scheduleRows()
                  }}
                  bind={bindArea}
                />
              </Match>
              <Match when={active().type === "permission"}>
                <RunPermissionBody
                  request={permissionView()!.request}
                  state={permission()}
                  theme={theme()}
                  diffStyle={props.diffStyle}
                  onHover={onPermissionHover}
                  onSelect={runPermission}
                  onMessage={onPermissionMessage}
                  onConfirmReject={onPermissionReject}
                  onCancelReject={onPermissionCancel}
                />
              </Match>
              <Match when={active().type === "question"}>
                <RunQuestionBody
                  request={questionView()!.request}
                  state={question()}
                  theme={theme()}
                  onTab={onQuestionTab}
                  onMove={onQuestionMove}
                  onOption={onQuestionOption}
                  onCustom={onQuestionCustom}
                />
              </Match>
            </Switch>
          </box>

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
