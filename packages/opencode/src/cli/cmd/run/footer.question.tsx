/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo } from "solid-js"
import type { QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { RunFooterTheme } from "./theme"

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
  state: QuestionBodyState
  theme: RunFooterTheme
  onTab: (index: number) => void
  onMove: (index: number) => void
  onOption: (index: number) => void
  onCustom: (text: string) => void
}) {
  const single = createMemo(() => questionSingle(props.request))
  const confirm = createMemo(() => questionConfirm(props.request, props.state))
  const info = createMemo(() => questionInfo(props.request, props.state))
  const input = createMemo(() => questionInput(props.state))
  const other = createMemo(() => questionOther(props.request, props.state))
  const picked = createMemo(() => questionPicked(props.state))
  const disabled = createMemo(() => props.state.submitting)
  let area: Area | undefined

  createEffect(() => {
    if (!props.state.editing || !area || area.isDestroyed) {
      return
    }

    if (area.plainText !== input()) {
      area.setText(input())
      area.cursorOffset = input().length
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed || !props.state.editing) {
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
              const active = () => props.state.tab === index()
              const answered = () => (props.state.answers[index()]?.length ?? 0) > 0
              return (
                <box
                  id={`run-direct-footer-question-tab-${index()}`}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? props.theme.highlight : props.theme.line}
                  onMouseUp={() => {
                    if (!disabled()) props.onTab(index())
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
              if (!disabled()) props.onTab(props.request.questions.length)
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
                    const value = () => props.state.answers[index()]?.join(", ") ?? ""
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
                  const active = () => props.state.selected === index()
                  const selected = () => props.state.answers[props.state.tab]?.includes(item.label) ?? false
                  return (
                    <box
                      id={`run-direct-footer-question-option-${index()}`}
                      flexDirection="column"
                      gap={0}
                      onMouseUp={() => {
                        if (!disabled()) props.onOption(index())
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

              <Show when={questionCustom(props.request, props.state)}>
                <box
                  id="run-direct-footer-question-option-custom"
                  flexDirection="column"
                  gap={0}
                  onMouseUp={() => {
                    if (!disabled()) props.onOption(info()?.options.length ?? 0)
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
                    when={props.state.editing}
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
                        props.onCustom(area.plainText)
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
        {hint(props.request, props.state)}
      </text>
    </box>
  )
}
