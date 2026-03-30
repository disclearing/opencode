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
  agent: string | undefined
  model: PromptModel | undefined
  variant: string | undefined
  files: RunFilePart[]
  initialInput?: string
  thinking: boolean
}

export type EntryKind = "system" | "user" | "assistant" | "tool" | "error"

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

export type FooterApi = {
  readonly isClosed: boolean
  onPrompt(fn: (text: string) => void): () => void
  onClose(fn: () => void): () => void
  patch(next: FooterPatch): void
  append(kind: EntryKind, text: string): void
  close(): void
  destroy(): void
}
