import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { TuiConfig } from "../../../config/tui"
import { Locale } from "../../../util/locale"
import { RunFooter } from "./footer"
import { formatUnknownError, runPromptTurn } from "./stream"
import type { FooterApi, FooterKeybinds, RunInput } from "./types"

const FOOTER_HEIGHT = 6

const DEFAULT_KEYBINDS: FooterKeybinds = {
  leader: "ctrl+x",
  variantCycle: "ctrl+t,<leader>t",
  interrupt: "escape",
  historyPrevious: "up",
  historyNext: "down",
  inputSubmit: "return",
  inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
}

function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function formatModelLabel(model: NonNullable<RunInput["model"]>, variant: string | undefined): string {
  const variantLabel = variant ? ` · ${variant}` : ""
  return `${model.modelID} · ${model.providerID}${variantLabel}`
}

function cycleVariant(current: string | undefined, variants: string[]): string | undefined {
  if (variants.length === 0) {
    return undefined
  }

  if (!current) {
    return variants[0]
  }

  const index = variants.indexOf(current)
  if (index === -1 || index === variants.length - 1) {
    return undefined
  }

  return variants[index + 1]
}

type ModelInfo = {
  variants: string[]
  limits: Record<string, number>
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

async function resolveModelInfo(sdk: RunInput["sdk"], model: RunInput["model"]): Promise<ModelInfo> {
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

async function resolveFirstPrompt(sdk: RunInput["sdk"], sessionID: string): Promise<boolean> {
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

async function resolveFooterKeybinds(): Promise<FooterKeybinds> {
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

function footerLabels(input: Pick<RunInput, "agent" | "model" | "variant">): {
  agentLabel: string
  modelLabel: string
} {
  const agentLabel = `Agent ${input.agent ?? "default"}`

  if (!input.model) {
    return {
      agentLabel,
      modelLabel: "Model default",
    }
  }

  return {
    agentLabel,
    modelLabel: formatModelLabel(input.model, input.variant),
  }
}

type QueueInput = {
  footer: FooterApi
  initialInput?: string
  run: (prompt: string) => Promise<void>
}

/** @internal Exported for testing */
export async function runPromptQueue(input: QueueInput): Promise<void> {
  const q: string[] = []
  let run = false
  let closed = input.footer.isClosed
  let err: unknown
  let hasErr = false
  let done: (() => void) | undefined
  const wait = new Promise<void>((resolve) => {
    done = resolve
  })

  const fail = (error: unknown) => {
    err = error
    hasErr = true
    done?.()
    done = undefined
  }

  const finish = () => {
    if (!closed || run) {
      return
    }

    done?.()
    done = undefined
  }

  const pump = async () => {
    if (run || closed) {
      return
    }

    run = true

    try {
      while (!closed && q.length > 0) {
        const prompt = q.shift()
        if (!prompt) {
          continue
        }

        input.footer.patch({
          phase: "running",
          status: "sending prompt",
          queue: q.length,
        })
        input.footer.append("user", prompt)
        const start = Date.now()
        try {
          await input.run(prompt)
        } finally {
          input.footer.patch({
            duration: Locale.duration(Math.max(0, Date.now() - start)),
          })
        }
      }
    } finally {
      run = false
      input.footer.patch({
        phase: "idle",
        status: "",
        queue: q.length,
      })
      finish()
    }
  }

  const push = (text: string) => {
    const prompt = text
    if (!prompt.trim() || closed) {
      return
    }

    q.push(prompt)
    input.footer.patch({ queue: q.length })
    input.footer.patch({ first: false })
    void pump().catch(fail)
  }

  const offPrompt = input.footer.onPrompt((text) => {
    push(text)
  })
  const offClose = input.footer.onClose(() => {
    closed = true
    q.length = 0
    finish()
  })

  try {
    if (closed) {
      return
    }

    push(input.initialInput ?? "")
    await pump()

    if (!closed) {
      await wait
    }

    if (hasErr) {
      throw err
    }
  } finally {
    offPrompt()
    offClose()
  }
}

export async function runInteractiveMode(input: RunInput): Promise<void> {
  const [keybinds, info, first] = await Promise.all([
    resolveFooterKeybinds(),
    resolveModelInfo(input.sdk, input.model),
    resolveFirstPrompt(input.sdk, input.sessionID),
  ])
  const variants = info.variants
  let activeVariant = input.variant
  let aborting = false

  const renderer = await createCliRenderer({
    targetFps: 30,
    maxFps: 60,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    useKittyKeyboard: { events: process.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  })

  const footer = new RunFooter(renderer, {
    ...footerLabels({
      agent: input.agent,
      model: input.model,
      variant: activeVariant,
    }),
    first,
    keybinds,
    onCycleVariant: () => {
      if (!input.model || variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      activeVariant = cycleVariant(activeVariant, variants)
      return {
        status: activeVariant ? `variant ${activeVariant}` : "variant default",
        modelLabel: formatModelLabel(input.model, activeVariant),
      }
    },
    onInterrupt: () => {
      if (aborting) {
        return
      }

      aborting = true
      void input.sdk.session
        .abort({
          sessionID: input.sessionID,
        })
        .catch(() => {})
        .finally(() => {
          aborting = false
        })
    },
  })

  try {
    footer.append("system", "Interactive mode enabled. Type /exit or /quit to finish.")
    let includeFiles = true
    await runPromptQueue({
      footer,
      initialInput: input.initialInput,
      run: async (prompt) => {
        try {
          await runPromptTurn({
            sdk: input.sdk,
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            variant: activeVariant,
            prompt,
            files: input.files,
            includeFiles,
            thinking: input.thinking,
            limits: info.limits,
            footer,
          })
          includeFiles = false
        } catch (error) {
          footer.append("error", formatUnknownError(error))
        }
      },
    })
  } finally {
    footer.close()
    footer.destroy()
    shutdown(renderer)
  }
}
