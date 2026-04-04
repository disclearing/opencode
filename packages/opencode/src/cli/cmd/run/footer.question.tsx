/** @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import type { QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { RunFooterTheme } from "./theme"
import type { QuestionReject, QuestionReply } from "./types"

type Area = {
  isDestroyed: boolean
  plainText: string
  cursorOffset: number
  setText(text: string): void
  focus(): void
}

export type QuestionBodyState = {
  requestID: string
  tab: number
  answers: string[][]
  custom: string[]
  selected: number
  editing: boolean
  submitting: boolean
}

export function createQuestionBodyState(requestID: string): QuestionBodyState {
  return {
    requestID,
    tab: 0,
    answers: [],
    custom: [],
    selected: 0,
    editing: false,
    submitting: false,
  }
}

export function questionSingle(request: QuestionRequest): boolean {
  return request.questions.length === 1 && request.questions[0]?.multiple !== true
}

export function questionTabs(request: QuestionRequest): number {
  return questionSingle(request) ? 1 : request.questions.length + 1
}

export function questionConfirm(request: QuestionRequest, state: QuestionBodyState): boolean {
  return !questionSingle(request) && state.tab === request.questions.length
}

export function questionInfo(request: QuestionRequest, state: QuestionBodyState): QuestionInfo | undefined {
  return request.questions[state.tab]
}

export function questionCustom(request: QuestionRequest, state: QuestionBodyState): boolean {
  return questionInfo(request, state)?.custom !== false
}

export function questionInput(state: QuestionBodyState): string {
  return state.custom[state.tab] ?? ""
}

export function questionPicked(state: QuestionBodyState): boolean {
  const value = questionInput(state)
  if (!value) {
    return false
  }

  return state.answers[state.tab]?.includes(value) ?? false
}

export function questionOther(request: QuestionRequest, state: QuestionBodyState): boolean {
  const info = questionInfo(request, state)
  if (!info || info.custom === false) {
    return false
  }

  return state.selected === info.options.length
}

export function questionTotal(request: QuestionRequest, state: QuestionBodyState): number {
  const info = questionInfo(request, state)
  if (!info) {
    return 0
  }

  return info.options.length + (questionCustom(request, state) ? 1 : 0)
}

export function questionAnswers(state: QuestionBodyState, count: number): string[][] {
  return Array.from({ length: count }, (_, i) => state.answers[i] ?? [])
}

function hint(request: QuestionRequest, state: QuestionBodyState): string {
  if (state.submitting) {
    return "Waiting for question event..."
  }

  if (questionConfirm(request, state)) {
    return "enter submit   esc dismiss"
  }

  if (state.editing) {
    return "enter save   esc cancel"
  }

  const info = questionInfo(request, state)
  if (questionSingle(request)) {
    return `↑↓ select   enter ${info?.multiple ? "toggle" : "submit"}   esc dismiss`
  }

  return `⇆ tab   ↑↓ select   enter ${info?.multiple ? "toggle" : "confirm"}   esc dismiss`
}

export function RunQuestionBody(props: {
  request: QuestionRequest
  theme: RunFooterTheme
  onReply: (input: QuestionReply) => void | Promise<void>
  onReject: (input: QuestionReject) => void | Promise<void>
}) {
  const [state, setState] = createSignal(createQuestionBodyState(props.request.id))
  const single = createMemo(() => questionSingle(props.request))
  const confirm = createMemo(() => questionConfirm(props.request, state()))
  const info = createMemo(() => questionInfo(props.request, state()))
  const input = createMemo(() => questionInput(state()))
  const other = createMemo(() => questionOther(props.request, state()))
  const picked = createMemo(() => questionPicked(state()))
  const disabled = createMemo(() => state().submitting)
  let area: Area | undefined

  createEffect(() => {
    const id = props.request.id
    if (state().requestID === id) {
      return
    }

    setState(createQuestionBodyState(id))
  })

  const setTab = (tab: number) => {
    setState((prev) => ({
      ...prev,
      tab,
      selected: 0,
      editing: false,
    }))
  }

  const move = (dir: -1 | 1) => {
    const total = questionTotal(props.request, state())
    if (total === 0) {
      return
    }

    setState((prev) => ({
      ...prev,
      selected: (prev.selected + dir + total) % total,
    }))
  }

  const storeAnswers = (tab: number, list: string[]) => {
    setState((prev) => {
      const answers = [...prev.answers]
      answers[tab] = list
      return {
        ...prev,
        answers,
      }
    })
  }

  const storeCustom = (tab: number, text: string) => {
    setState((prev) => {
      const custom = [...prev.custom]
      custom[tab] = text
      return {
        ...prev,
        custom,
      }
    })
  }

  const beginReply = async (input: QuestionReply) => {
    setState((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onReply(input)
    } catch {
      setState((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const beginReject = async (input: QuestionReject) => {
    setState((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onReject(input)
    } catch {
      setState((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const pick = (answer: string, custom = false) => {
    const cur = state()
    const answers = [...cur.answers]
    answers[cur.tab] = [answer]
    const next = {
      ...cur,
      answers,
      editing: false,
    }
    if (custom) {
      const list = [...cur.custom]
      list[cur.tab] = answer
      next.custom = list
    }
    setState(next)

    if (single()) {
      void beginReply({
        requestID: props.request.id,
        answers: [[answer]],
      })
      return
    }

    setTab(cur.tab + 1)
  }

  const toggle = (answer: string) => {
    const cur = state()
    const list = [...(cur.answers[cur.tab] ?? [])]
    const idx = list.indexOf(answer)
    if (idx === -1) {
      list.push(answer)
    } else {
      list.splice(idx, 1)
    }
    storeAnswers(cur.tab, list)
  }

  const saveCustom = () => {
    const cur = state()
    const item = questionInfo(props.request, cur)
    if (!item) {
      return
    }

    const text = questionInput(cur).trim()
    const prev = cur.custom[cur.tab]
    if (!text) {
      if (prev) {
        storeCustom(cur.tab, "")
        storeAnswers(
          cur.tab,
          (cur.answers[cur.tab] ?? []).filter((entry) => entry !== prev),
        )
      }
      setState((next) => ({
        ...next,
        editing: false,
      }))
      return
    }

    if (item.multiple) {
      const answers = [...(cur.answers[cur.tab] ?? [])]
      if (prev) {
        const idx = answers.indexOf(prev)
        if (idx !== -1) {
          answers.splice(idx, 1)
        }
      }
      if (!answers.includes(text)) {
        answers.push(text)
      }
      storeCustom(cur.tab, text)
      storeAnswers(cur.tab, answers)
      setState((next) => ({
        ...next,
        editing: false,
      }))
      return
    }

    pick(text, true)
  }

  const select = () => {
    const cur = state()
    const item = questionInfo(props.request, cur)
    if (!item) {
      return
    }

    if (questionOther(props.request, cur)) {
      if (!item.multiple) {
        setState((next) => ({
          ...next,
          editing: true,
        }))
        return
      }

      const value = questionInput(cur)
      if (value && questionPicked(cur)) {
        toggle(value)
        return
      }

      setState((next) => ({
        ...next,
        editing: true,
      }))
      return
    }

    const option = item.options[cur.selected]
    if (!option) {
      return
    }

    if (item.multiple) {
      toggle(option.label)
      return
    }

    pick(option.label)
  }

  const submit = () => {
    void beginReply({
      requestID: props.request.id,
      answers: questionAnswers(state(), props.request.questions.length),
    })
  }

  const reject = () => {
    void beginReject({
      requestID: props.request.id,
    })
  }

  useKeyboard((event) => {
    const cur = state()
    if (cur.submitting) {
      event.preventDefault()
      return
    }

    if (cur.editing) {
      if (event.name === "escape") {
        setState((prev) => ({
          ...prev,
          editing: false,
        }))
        event.preventDefault()
        return
      }

      if (event.name === "return" && !event.shift && !event.ctrl && !event.meta) {
        saveCustom()
        event.preventDefault()
      }
      return
    }

    if (!single() && (event.name === "left" || event.name === "h")) {
      setTab((cur.tab - 1 + questionTabs(props.request)) % questionTabs(props.request))
      event.preventDefault()
      return
    }

    if (!single() && (event.name === "right" || event.name === "l")) {
      setTab((cur.tab + 1) % questionTabs(props.request))
      event.preventDefault()
      return
    }

    if (!single() && event.name === "tab") {
      const dir = event.shift ? -1 : 1
      setTab((cur.tab + dir + questionTabs(props.request)) % questionTabs(props.request))
      event.preventDefault()
      return
    }

    if (questionConfirm(props.request, cur)) {
      if (event.name === "return") {
        submit()
        event.preventDefault()
        return
      }

      if (event.name === "escape") {
        reject()
        event.preventDefault()
      }
      return
    }

    const total = questionTotal(props.request, cur)
    const max = Math.min(total, 9)
    const digit = Number(event.name)
    if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
      setState((prev) => ({
        ...prev,
        selected: digit - 1,
      }))
      select()
      event.preventDefault()
      return
    }

    if (event.name === "up" || event.name === "k") {
      move(-1)
      event.preventDefault()
      return
    }

    if (event.name === "down" || event.name === "j") {
      move(1)
      event.preventDefault()
      return
    }

    if (event.name === "return") {
      select()
      event.preventDefault()
      return
    }

    if (event.name === "escape") {
      reject()
      event.preventDefault()
    }
  })

  createEffect(() => {
    if (!state().editing || !area || area.isDestroyed) {
      return
    }

    if (area.plainText !== input()) {
      area.setText(input())
      area.cursorOffset = input().length
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed || !state().editing) {
        return
      }

      area.focus()
      area.cursorOffset = area.plainText.length
    })
  })

  return (
    <box id="run-direct-footer-question-body" width="100%" height="100%" flexDirection="column" gap={1}>
      <Show when={!single()}>
        <box id="run-direct-footer-question-tabs" flexDirection="row" gap={1} flexShrink={0}>
          <For each={props.request.questions}>
            {(item, index) => {
              const active = () => state().tab === index()
              const answered = () => (state().answers[index()]?.length ?? 0) > 0
              return (
                <box
                  id={`run-direct-footer-question-tab-${index()}`}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? props.theme.highlight : props.theme.line}
                  onMouseUp={() => {
                    if (!disabled()) setTab(index())
                  }}
                >
                  <text fg={active() ? props.theme.surface : answered() ? props.theme.text : props.theme.muted}>
                    {item.header}
                  </text>
                </box>
              )
            }}
          </For>
          <box
            id="run-direct-footer-question-tab-confirm"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={confirm() ? props.theme.highlight : props.theme.line}
            onMouseUp={() => {
              if (!disabled()) setTab(props.request.questions.length)
            }}
          >
            <text fg={confirm() ? props.theme.surface : props.theme.muted}>Confirm</text>
          </box>
        </box>
      </Show>

      <box width="100%" flexGrow={1} flexShrink={1}>
        <Show
          when={!confirm()}
          fallback={
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
                <text fg={props.theme.text}>Review</text>
                <For each={props.request.questions}>
                  {(item, index) => {
                    const value = () => state().answers[index()]?.join(", ") ?? ""
                    return (
                      <text fg={value() ? props.theme.text : props.theme.muted} wrapMode="word">
                        {item.header}: {value() || "(not answered)"}
                      </text>
                    )
                  }}
                </For>
              </box>
            </scrollbox>
          }
        >
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
              <text fg={props.theme.text} wrapMode="word">
                {info()?.question}
                {info()?.multiple ? " (select all that apply)" : ""}
              </text>

              <For each={info()?.options ?? []}>
                {(item, index) => {
                  const active = () => state().selected === index()
                  const selected = () => state().answers[state().tab]?.includes(item.label) ?? false
                  return (
                    <box
                      id={`run-direct-footer-question-option-${index()}`}
                      flexDirection="column"
                      gap={0}
                      onMouseUp={() => {
                        if (!disabled()) {
                          setState((prev) => ({
                            ...prev,
                            selected: index(),
                          }))
                          select()
                        }
                      }}
                    >
                      <box backgroundColor={active() ? props.theme.line : undefined} flexDirection="row" gap={1}>
                        <text fg={active() ? props.theme.highlight : props.theme.muted}>{`${index() + 1}.`}</text>
                        <text fg={active() ? props.theme.highlight : selected() ? props.theme.text : props.theme.text}>
                          {info()?.multiple ? `[${selected() ? "x" : " "}] ${item.label}` : item.label}
                        </text>
                      </box>
                      <text fg={props.theme.muted} wrapMode="word">
                        {item.description}
                      </text>
                    </box>
                  )
                }}
              </For>

              <Show when={questionCustom(props.request, state())}>
                <box
                  id="run-direct-footer-question-option-custom"
                  flexDirection="column"
                  gap={0}
                  onMouseUp={() => {
                    if (!disabled()) {
                      setState((prev) => ({
                        ...prev,
                        selected: info()?.options.length ?? 0,
                      }))
                      select()
                    }
                  }}
                >
                  <box backgroundColor={other() ? props.theme.line : undefined} flexDirection="row" gap={1}>
                    <text
                      fg={other() ? props.theme.highlight : props.theme.muted}
                    >{`${(info()?.options.length ?? 0) + 1}.`}</text>
                    <text fg={other() ? props.theme.highlight : picked() ? props.theme.text : props.theme.text}>
                      {info()?.multiple ? `[${picked() ? "x" : " "}] Type your own answer` : "Type your own answer"}
                    </text>
                  </box>
                  <Show
                    when={state().editing}
                    fallback={
                      <Show when={input()}>
                        <text fg={props.theme.muted}>{input()}</text>
                      </Show>
                    }
                  >
                    <textarea
                      id="run-direct-footer-question-custom"
                      width="100%"
                      minHeight={1}
                      maxHeight={4}
                      wrapMode="word"
                      placeholder="Type your own answer"
                      placeholderColor={props.theme.muted}
                      textColor={props.theme.text}
                      focusedTextColor={props.theme.text}
                      backgroundColor={props.theme.surface}
                      focusedBackgroundColor={props.theme.surface}
                      cursorColor={props.theme.text}
                      focused={!disabled()}
                      onContentChange={() => {
                        if (!area || area.isDestroyed || disabled()) {
                          return
                        }
                        storeCustom(state().tab, area.plainText)
                      }}
                      ref={(item) => {
                        area = item as Area
                      }}
                    />
                  </Show>
                </box>
              </Show>
            </box>
          </scrollbox>
        </Show>
      </box>

      <text id="run-direct-footer-question-hint" fg={props.theme.muted} wrapMode="word" flexShrink={0}>
        {hint(props.request, state())}
      </text>
    </box>
  )
}
