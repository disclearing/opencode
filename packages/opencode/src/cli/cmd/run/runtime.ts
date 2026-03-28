import { CliRenderer, createCliRenderer, type ScrollbackWriter } from "@opentui/core"
import { DirectRunFooter, type ScrollbackRenderer } from "./footer"
import { formatUnknownError, runDirectPromptTurn } from "./stream"
import type { DirectRunInput } from "./types"

const DIRECT_FOOTER_HEIGHT = 9

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

  const variantLabel = input.variant ? ` · ${input.variant}` : ""
  return {
    agentLabel,
    modelLabel: `${input.model.modelID} · ${input.model.providerID}${variantLabel}`,
  }
}

export async function runDirectMode(input: DirectRunInput): Promise<void> {
  ensureScrollbackApiAvailable()

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

  const footer = new DirectRunFooter(renderer, directFooterLabels(input))
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
          variant: input.variant,
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
      footer.setIdle("ready")
    }
  } finally {
    footer.destroy()
    if (!renderer.isDestroyed) {
      renderer.destroy()
    }
  }
}
