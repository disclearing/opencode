import { CliRenderer, createCliRenderer, type ScrollbackWriter } from "@opentui/core"
import { Config } from "../../../config/config"
import { DirectRunFooter, type DirectFooterKeybinds, type ScrollbackRenderer } from "./footer"
import { formatUnknownError, runDirectPromptTurn } from "./stream"
import type { DirectRunInput } from "./types"

const DIRECT_FOOTER_HEIGHT = 9

const DEFAULT_DIRECT_KEYBINDS: DirectFooterKeybinds = {
  leader: "ctrl+x",
  variantCycle: "ctrl+t,<leader>t",
  inputSubmit: "return",
  inputNewline: "shift+return,ctrl+return,alt+return,ctrl+j",
}

function formatModelLabel(model: NonNullable<DirectRunInput["model"]>, variant: string | undefined): string {
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

async function resolveModelVariants(sdk: DirectRunInput["sdk"], model: DirectRunInput["model"]): Promise<string[]> {
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

async function resolveFooterKeybinds(): Promise<DirectFooterKeybinds> {
  try {
    const config = await Config.get()
    const configuredLeader = config.keybinds?.leader?.trim() || DEFAULT_DIRECT_KEYBINDS.leader
    const configuredVariantCycle = config.keybinds?.variant_cycle?.trim() || "ctrl+t"
    const configuredSubmit = config.keybinds?.input_submit?.trim() || DEFAULT_DIRECT_KEYBINDS.inputSubmit
    const configuredNewline = config.keybinds?.input_newline?.trim() || DEFAULT_DIRECT_KEYBINDS.inputNewline

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
    return DEFAULT_DIRECT_KEYBINDS
  }
}

function ensureScrollbackApiAvailable(): void {
  const prototype = CliRenderer.prototype as CliRenderer & {
    writeToScrollback?: unknown
  }

  if (typeof prototype.writeToScrollback === "function") {
    return
  }

  throw new Error(
    'run --interactive requires @opentui/core with writeToScrollback(). Link your local cli-render-api worktree (e.g. "bun link @opentui/core") before running this mode.',
  )
}

function resolveScrollbackRenderer(renderer: CliRenderer): ScrollbackRenderer {
  const candidate = renderer as CliRenderer & {
    writeToScrollback?: (write: ScrollbackWriter) => void
  }

  if (typeof candidate.writeToScrollback === "function") {
    return candidate as ScrollbackRenderer
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }

  throw new Error(
    'run --interactive requires @opentui/core with writeToScrollback(). Link your local cli-render-api worktree (e.g. "bun link @opentui/core") before running this mode.',
  )
}

function directFooterLabels(input: Pick<DirectRunInput, "agent" | "model" | "variant">): {
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

export async function runDirectMode(input: DirectRunInput): Promise<void> {
  ensureScrollbackApiAvailable()

  const [keybinds, variants] = await Promise.all([
    resolveFooterKeybinds(),
    resolveModelVariants(input.sdk, input.model),
  ])
  let activeVariant = input.variant

  const renderer = resolveScrollbackRenderer(
    await createCliRenderer({
      targetFps: 30,
      maxFps: 60,
      useMouse: false,
      autoFocus: false,
      openConsoleOnError: false,
      exitOnCtrlC: true,
      useKittyKeyboard: { events: process.platform === "win32" },
      screenMode: "split-footer",
      footerHeight: DIRECT_FOOTER_HEIGHT,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    }),
  )

  const footer = new DirectRunFooter(renderer, {
    ...directFooterLabels({
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
  renderer.start()

  try {
    footer.append("system", "Interactive direct mode enabled. Type /exit or /quit to finish.")

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
        await runDirectPromptTurn({
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
