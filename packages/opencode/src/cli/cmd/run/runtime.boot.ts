import { TuiConfig } from "../../../config/tui"
import type { FooterKeybinds, RunDiffStyle, RunInput } from "./types"
import { pickVariant } from "./variant.shared"

const HISTORY_LIMIT = 200

const DEFAULT_KEYBINDS: FooterKeybinds = {
  leader: "ctrl+x",
  variantCycle: "ctrl+t,<leader>t",
  interrupt: "escape",
  historyPrevious: "up",
  historyNext: "down",
  inputSubmit: "return",
  inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
}

type SessionMessages = NonNullable<Awaited<ReturnType<RunInput["sdk"]["session"]["messages"]>>["data"]>

export type ModelInfo = {
  variants: string[]
  limits: Record<string, number>
}

export type SessionInfo = {
  first: boolean
  history: string[]
  variant: string | undefined
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

export async function resolveModelInfo(sdk: RunInput["sdk"], model: RunInput["model"]): Promise<ModelInfo> {
  try {
    const response = await sdk.provider.list()
    const providers = response.data?.all ?? []
    const limits: Record<string, number> = {}

    for (const provider of providers) {
      for (const [modelID, info] of Object.entries(provider.models ?? {})) {
        const limit = info?.limit?.context
        if (typeof limit === "number" && limit > 0) {
          limits[modelKey(provider.id, modelID)] = limit
        }
      }
    }

    if (!model) {
      return {
        variants: [],
        limits,
      }
    }

    const provider = providers.find((item) => item.id === model.providerID)
    const modelInfo = provider?.models?.[model.modelID]
    return {
      variants: Object.keys(modelInfo?.variants ?? {}),
      limits,
    }
  } catch {
    return {
      variants: [],
      limits: {},
    }
  }
}

export async function resolveFirstPrompt(sdk: RunInput["sdk"], sessionID: string): Promise<boolean> {
  try {
    const response = await sdk.session.messages({
      sessionID,
      limit: 1,
    })
    return (response.data ?? []).length === 0
  } catch {
    return true
  }
}

function promptHistory(messages: SessionMessages): string[] {
  const history: string[] = []

  for (const message of messages) {
    if (message.info.role !== "user") {
      continue
    }

    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join("\n")

    if (!text || history[history.length - 1] === text) {
      continue
    }

    history.push(text)
  }

  return history.slice(-HISTORY_LIMIT)
}

export async function resolveSessionInfo(
  sdk: RunInput["sdk"],
  sessionID: string,
  model: RunInput["model"],
): Promise<SessionInfo> {
  try {
    const response = await sdk.session.messages({
      sessionID,
      limit: HISTORY_LIMIT,
    })
    const messages = response.data ?? []
    return {
      first: messages.length === 0,
      history: promptHistory(messages),
      variant: pickVariant(model, messages),
    }
  } catch {
    return {
      first: true,
      history: [],
      variant: undefined,
    }
  }
}

export async function resolveFooterKeybinds(): Promise<FooterKeybinds> {
  try {
    const config = await TuiConfig.get()
    const configuredLeader = config.keybinds?.leader?.trim() || DEFAULT_KEYBINDS.leader
    const configuredVariantCycle = config.keybinds?.variant_cycle?.trim() || "ctrl+t"
    const configuredInterrupt = config.keybinds?.session_interrupt?.trim() || DEFAULT_KEYBINDS.interrupt
    const configuredHistoryPrevious = config.keybinds?.history_previous?.trim() || DEFAULT_KEYBINDS.historyPrevious
    const configuredHistoryNext = config.keybinds?.history_next?.trim() || DEFAULT_KEYBINDS.historyNext
    const configuredSubmit = config.keybinds?.input_submit?.trim() || DEFAULT_KEYBINDS.inputSubmit
    const configuredNewline = config.keybinds?.input_newline?.trim() || DEFAULT_KEYBINDS.inputNewline

    const variantBindings = configuredVariantCycle
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

    if (!variantBindings.some((binding) => binding.toLowerCase() === "<leader>t")) {
      variantBindings.push("<leader>t")
    }

    return {
      leader: configuredLeader,
      variantCycle: variantBindings.join(","),
      interrupt: configuredInterrupt,
      historyPrevious: configuredHistoryPrevious,
      historyNext: configuredHistoryNext,
      inputSubmit: configuredSubmit,
      inputNewline: configuredNewline,
    }
  } catch {
    return DEFAULT_KEYBINDS
  }
}

export async function resolveDiffStyle(): Promise<RunDiffStyle> {
  try {
    const config = await TuiConfig.get()
    return config.diff_style ?? "auto"
  } catch {
    return "auto"
  }
}
