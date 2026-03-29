import { createCliRenderer } from "@opentui/core"
import { TuiConfig } from "../../../config/tui"
import { RunFooter, type FooterKeybinds } from "./footer"
import { formatUnknownError, runPromptTurn } from "./stream"
import type { RunInput } from "./types"

const FOOTER_HEIGHT = 7

const DEFAULT_KEYBINDS: FooterKeybinds = {
  leader: "ctrl+x",
  variantCycle: "ctrl+t,<leader>t",
  inputSubmit: "return",
  inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
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

async function resolveModelVariants(sdk: RunInput["sdk"], model: RunInput["model"]): Promise<string[]> {
  if (!model) {
    return []
  }

  try {
    const response = await sdk.provider.list()
    const providers = response.data?.all ?? []
    const provider = providers.find((item) => item.id === model.providerID)
    const modelInfo = provider?.models?.[model.modelID]
    return Object.keys(modelInfo?.variants ?? {})
  } catch {
    return []
  }
}

async function resolveFooterKeybinds(): Promise<FooterKeybinds> {
  try {
    const config = await TuiConfig.get()
    const configuredLeader = config.keybinds?.leader?.trim() || DEFAULT_KEYBINDS.leader
    const configuredVariantCycle = config.keybinds?.variant_cycle?.trim() || "ctrl+t"
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

export async function runInteractiveMode(input: RunInput): Promise<void> {
  const [keybinds, variants] = await Promise.all([
    resolveFooterKeybinds(),
    resolveModelVariants(input.sdk, input.model),
  ])
  let activeVariant = input.variant

  const renderer = await createCliRenderer({
    targetFps: 30,
    maxFps: 60,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: true,
    useKittyKeyboard: { events: process.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer.start()

  const footer = new RunFooter(renderer, {
    ...footerLabels({
      agent: input.agent,
      model: input.model,
      variant: activeVariant,
    }),
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
  })

  try {
    footer.append("system", "Interactive mode enabled. Type /exit or /quit to finish.")

    let includeFiles = true
    let prompt: string | null | undefined = input.initialInput?.trim() ? input.initialInput : undefined

    while (!footer.isClosed) {
      if (!prompt) {
        prompt = await footer.waitForInput()
        if (!prompt) {
          break
        }
      }

      footer.append("user", prompt)
      footer.setBusy("sending prompt")

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
          footer,
        })
        includeFiles = false
      } catch (error) {
        footer.append("error", formatUnknownError(error))
      }

      prompt = undefined
      footer.setIdle("")
    }
  } finally {
    footer.destroy()
    if (!renderer.isDestroyed) {
      renderer.destroy()
    }
  }
}
