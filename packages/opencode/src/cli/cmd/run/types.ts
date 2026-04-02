import type { OpencodeClient } from "@opencode-ai/sdk/v2"

export type RunFilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type PromptModel = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

export type RunInput = {
  sdk: OpencodeClient
  sessionID: string
  sessionTitle?: string
  resume?: boolean
  agent: string | undefined
  model: PromptModel | undefined
  variant: string | undefined
  files: RunFilePart[]
  initialInput?: string
  thinking: boolean
}

export type EntryKind = "system" | "user" | "assistant" | "reasoning" | "tool" | "error"

export type FooterPhase = "idle" | "running"

export type FooterState = {
  phase: FooterPhase
  status: string
  queue: number
  model: string
  duration: string
  usage: string
  first: boolean
  interrupt: number
  exit: number
}

export type FooterPatch = Partial<FooterState>

export type FooterKeybinds = {
  leader: string
  variantCycle: string
  interrupt: string
  historyPrevious: string
  historyNext: string
  inputSubmit: string
  inputNewline: string
}

export type StreamPhase = "start" | "progress" | "final"

export type StreamSource = "assistant" | "reasoning" | "tool" | "system"

export type StreamCommit = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  source: StreamSource
  partID?: string
  tool?: string
}

export type FooterApi = {
  readonly isClosed: boolean
  onPrompt(fn: (text: string) => void): () => void
  onClose(fn: () => void): () => void
  patch(next: FooterPatch): void
  append(commit: StreamCommit): void
  close(): void
  destroy(): void
}
