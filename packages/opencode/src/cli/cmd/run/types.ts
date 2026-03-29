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
