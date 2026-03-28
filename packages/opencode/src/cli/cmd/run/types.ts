import type { OpencodeClient } from "@opencode-ai/sdk/v2"

export type DirectRunFilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type PromptModel = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

export type DirectRunInput = {
  sdk: OpencodeClient
  sessionID: string
  agent: string | undefined
  model: PromptModel | undefined
  variant: string | undefined
  files: DirectRunFilePart[]
  initialInput?: string
  thinking: boolean
}

export type DirectEntryKind = "system" | "user" | "assistant" | "tool" | "error"
