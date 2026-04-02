import path from "path"
import { createCliRenderer, type CliRenderer, type ScrollbackWriter } from "@opentui/core"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { TuiConfig } from "../../../config/tui"
import { Global } from "../../../global"
import { Filesystem } from "../../../util/filesystem"
import { Locale } from "../../../util/locale"
import { RunFooter } from "./footer"
import { entrySplash, exitSplash, splashMeta } from "./splash"
import { formatUnknownError, runPromptTurn } from "./stream"
import { resolveRunTheme } from "./theme"
import type { FooterApi, FooterKeybinds, RunInput } from "./types"

const FOOTER_HEIGHT = 6
const HISTORY_LIMIT = 200
const MODEL_FILE = path.join(Global.Path.state, "model.json")
const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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

type SessionInfo = {
  first: boolean
  history: string[]
  variant: string | undefined
}

type SessionMessages = NonNullable<Awaited<ReturnType<RunInput["sdk"]["session"]["messages"]>>["data"]>

type ModelState = {
  variant?: Record<string, string | undefined>
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function variantKey(model: NonNullable<RunInput["model"]>): string {
  return modelKey(model.providerID, model.modelID)
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

/** @internal Exported for testing */
export function pickVariant(model: RunInput["model"], messages: SessionMessages): string | undefined {
  if (!model || !messages || messages.length === 0) {
    return undefined
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info
    if (!info || info.role !== "user") {
      continue
    }

    if (info.model.providerID !== model.providerID || info.model.modelID !== model.modelID) {
      continue
    }

    return info.variant
  }

  return undefined
}

function fitVariant(value: string | undefined, variants: string[]): string | undefined {
  if (!value) {
    return undefined
  }

  if (variants.length === 0 || variants.includes(value)) {
    return value
  }

  return undefined
}

/** @internal Exported for testing */
export function resolveVariant(
  input: string | undefined,
  session: string | undefined,
  saved: string | undefined,
  variants: string[],
): string | undefined {
  if (input !== undefined) {
    return input
  }

  const fallback = fitVariant(saved, variants)
  const current = fitVariant(session, variants)
  if (current !== undefined) {
    return current
  }

  return fallback
}

async function resolveSessionInfo(
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

async function resolveSavedVariant(model: RunInput["model"]): Promise<string | undefined> {
  if (!model) {
    return undefined
  }

  try {
    const state = await Filesystem.readJson<ModelState>(MODEL_FILE)
    return state.variant?.[variantKey(model)]
  } catch {
    return undefined
  }
}

function saveVariant(model: RunInput["model"], variant: string | undefined): void {
  if (!model) {
    return
  }

  void (async () => {
    const state = await Filesystem.readJson<ModelState>(MODEL_FILE).catch(() => ({}) as ModelState)
    const map = {
      ...(state.variant ?? {}),
    }
    const key = variantKey(model)
    if (variant) {
      map[key] = variant
    }

    if (!variant) {
      delete map[key]
    }

    await Filesystem.writeJson(MODEL_FILE, {
      ...state,
      variant: map,
    })
  })().catch(() => {})
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
  const agentLabel = Locale.titlecase(input.agent ?? "build")

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
  run: (prompt: string, signal: AbortSignal) => Promise<void>
}

type SplashState = {
  entry: boolean
  exit: boolean
}

/** @internal Exported for testing */
export function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

function isExitPrompt(text: string): boolean {
  const value = text.trim().toLowerCase()
  return value === "/exit" || value === "/quit"
}

function splashTitle(title: string | undefined, history: string[]): string | undefined {
  if (title && !DEFAULT_TITLE.test(title)) {
    return title
  }

  const next = history.find((item) => item.trim().length > 0)
  return next ?? title
}

/** @internal Exported for testing */
export async function runPromptQueue(input: QueueInput): Promise<void> {
  const q: string[] = []
  let turn = 0
  let run = false
  let closed = input.footer.isClosed
  let ctrl: AbortController | undefined
  let stop: (() => void) | undefined
  let err: unknown
  let hasErr = false
  let done: (() => void) | undefined
  const wait = new Promise<void>((resolve) => {
    done = resolve
  })
  const until = new Promise<void>((resolve) => {
    stop = resolve
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
        const start = Date.now()
        const next = new AbortController()
        ctrl = next
        try {
          const task = input.run(prompt, next.signal).then(
            () => ({ type: "done" as const }),
            (error) => ({ type: "error" as const, error }),
          )
          await input.footer.idle()
          const text = turn === 0 ? prompt : `\n${prompt}`
          turn += 1
          input.footer.append({ kind: "user", text, phase: "start", source: "system" })
          const out = await Promise.race([task, until.then(() => ({ type: "closed" as const }))])
          if (out.type === "closed") {
            next.abort()
            break
          }

          if (out.type === "error") {
            throw out.error
          }
        } finally {
          if (ctrl === next) {
            ctrl = undefined
          }
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

    if (isExitPrompt(prompt)) {
      input.footer.close()
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
    ctrl?.abort()
    stop?.()
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

type BootContext = Pick<RunInput, "sdk" | "sessionID" | "sessionTitle" | "resume" | "agent" | "model" | "variant">

type RunBootInput = {
  boot: () => Promise<BootContext>
  afterPaint?: (ctx: BootContext) => Promise<void> | void
  agent: RunInput["agent"]
  model: RunInput["model"]
  variant: RunInput["variant"]
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
}

type RunLocalInput = {
  fetch: typeof globalThis.fetch
  resolveAgent: () => Promise<string | undefined>
  session: (sdk: RunInput["sdk"]) => Promise<{ id: string; title?: string } | undefined>
  share: (sdk: RunInput["sdk"], sessionID: string) => Promise<void>
  agent: RunInput["agent"]
  model: RunInput["model"]
  variant: RunInput["variant"]
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
}

function waitReady<T>(task: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined)
  }

  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      resolve(undefined)
    }

    signal.addEventListener("abort", onAbort, { once: true })
    void task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export async function runInteractiveBootMode(input: RunBootInput): Promise<void> {
  const keybindsTask = resolveFooterKeybinds()
  const ready = input.boot()
  const seeded = Boolean(input.initialInput?.trim())
  const state: SplashState = {
    entry: false,
    exit: false,
  }
  let meta: ReturnType<typeof splashMeta> | undefined
  let first = true
  let sessionVariant: string | undefined
  let savedVariant: string | undefined
  let variants: string[] = []
  let limits: Record<string, number> = {}
  let activeVariant = input.variant
  let aborting = false
  let ctx: BootContext | undefined
  let modelTask: Promise<void> | undefined

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
  const theme = await resolveRunTheme(renderer)
  renderer.setBackgroundColor(theme.background)
  const keybinds = await keybindsTask

  const footer = new RunFooter(renderer, {
    ...footerLabels({
      agent: input.agent,
      model: input.model,
      variant: activeVariant,
    }),
    first,
    history: [],
    theme,
    keybinds,
    onCycleVariant: () => {
      const model = ctx?.model ?? input.model
      if (!model || variants.length === 0) {
        if (ctx) {
          loadModel(ctx)
          return {
            status: "loading variants",
          }
        }

        return {
          status: "no variants available",
        }
      }

      activeVariant = cycleVariant(activeVariant, variants)
      saveVariant(model, activeVariant)
      return {
        status: activeVariant ? `variant ${activeVariant}` : "variant default",
        modelLabel: formatModelLabel(model, activeVariant),
      }
    },
    onInterrupt: () => {
      if (!ctx) {
        footer.patch({ status: "starting backend" })
        return
      }

      if (aborting) {
        return
      }

      aborting = true
      void ctx.sdk.session
        .abort({
          sessionID: ctx.sessionID,
        })
        .catch(() => {})
        .finally(() => {
          aborting = false
        })
    },
  })
  footer.patch({ status: "starting backend" })
  queueSplash(
    renderer,
    state,
    "entry",
    entrySplash({
      title: "",
      session_id: "",
      theme: theme.entry,
      background: theme.background,
      showSession: false,
    }),
  )

  const loadModel = (next: BootContext) => {
    if (modelTask) {
      return
    }

    modelTask = resolveModelInfo(next.sdk, next.model)
      .then((info) => {
        variants = info.variants
        limits = info.limits
        const variant = resolveVariant(next.variant, sessionVariant, savedVariant, variants)
        if (variant === activeVariant) {
          return
        }

        activeVariant = variant
        if (!next.model || footer.isClosed) {
          return
        }

        footer.patch({
          model: formatModelLabel(next.model, activeVariant),
        })
      })
      .catch(() => {})
  }

  const setup = ready
    .then(async (next) => {
      ctx = next
      meta = splashMeta({
        title: next.sessionTitle,
        session_id: next.sessionID,
      })

      footer.patch({ status: "loading session" })
      const [session, saved] = await Promise.all([
        resolveSessionInfo(next.sdk, next.sessionID, next.model),
        resolveSavedVariant(next.model),
      ])

      first = session.first
      sessionVariant = session.variant
      savedVariant = saved
      activeVariant = resolveVariant(next.variant, sessionVariant, savedVariant, variants)
      if (next.model) {
        footer.patch({
          model: formatModelLabel(next.model, activeVariant),
        })
      }

      if (!session.first) {
        footer.patch({ first: false })
      }

      footer.patch({ status: "" })

      if (input.afterPaint) {
        void Promise.resolve(input.afterPaint(next)).catch(() => {})
      }
    })
    .catch((error) => {
      if (footer.isClosed) {
        return
      }

      footer.append({ kind: "error", text: formatUnknownError(error), phase: "start", source: "system" })
      footer.patch({ status: "backend failed" })
    })

  const sigint = () => {
    footer.requestExit()
  }
  process.on("SIGINT", sigint)

  try {
    if (seeded) {
      await setup
    }

    let includeFiles = true
    await runPromptQueue({
      footer,
      initialInput: input.initialInput,
      run: async (prompt, signal) => {
        try {
          const next = await waitReady(ready, signal)
          if (!next || signal.aborted || footer.isClosed) {
            return
          }

          await runPromptTurn({
            sdk: next.sdk,
            sessionID: next.sessionID,
            agent: next.agent,
            model: next.model,
            variant: activeVariant,
            prompt,
            files: input.files,
            includeFiles,
            thinking: input.thinking,
            limits,
            footer,
            signal,
          })
          includeFiles = false
          loadModel(next)
        } catch (error) {
          if (signal.aborted || footer.isClosed) {
            return
          }
          footer.append({ kind: "error", text: formatUnknownError(error), phase: "start", source: "system" })
        }
      },
    })
  } finally {
    process.off("SIGINT", sigint)

    if (!renderer.isDestroyed && ctx) {
      const hasMessages = !(await resolveFirstPrompt(ctx.sdk, ctx.sessionID))
      if (hasMessages && meta) {
        queueSplash(
          renderer,
          state,
          "exit",
          exitSplash({
            ...meta,
            theme: theme.entry,
            background: theme.background,
          }),
        )
        await renderer.idle().catch(() => {})
      }
    }

    footer.close()
    footer.destroy()
    shutdown(renderer)
  }
}

export async function runInteractiveLocalMode(input: RunLocalInput): Promise<void> {
  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: input.fetch,
  })

  return runInteractiveBootMode({
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    files: input.files,
    initialInput: input.initialInput,
    thinking: input.thinking,
    afterPaint: (ctx) => input.share(ctx.sdk, ctx.sessionID),
    boot: async () => {
      const agent = await input.resolveAgent()
      const sess = await input.session(sdk)
      if (!sess?.id) {
        throw new Error("Session not found")
      }

      return {
        sdk,
        sessionID: sess.id,
        sessionTitle: sess.title,
        resume: false,
        agent,
        model: input.model,
        variant: input.variant,
      }
    },
  })
}

export async function runInteractiveMode(input: RunInput): Promise<void> {
  const keybindsTask = resolveFooterKeybinds()
  const modelTask = resolveModelInfo(input.sdk, input.model)
  const sessionTask = resolveSessionInfo(input.sdk, input.sessionID, input.model)
  const savedTask = resolveSavedVariant(input.model)

  const state: SplashState = {
    entry: false,
    exit: false,
  }
  let variants: string[] = []
  let limits: Record<string, number> = {}

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
  const theme = await resolveRunTheme(renderer)
  renderer.setBackgroundColor(theme.background)
  const [keybinds, session, savedVariant] = await Promise.all([keybindsTask, sessionTask, savedTask])
  const meta = splashMeta({
    title: splashTitle(input.sessionTitle, session.history),
    session_id: input.sessionID,
  })
  queueSplash(
    renderer,
    state,
    "entry",
    entrySplash({
      ...meta,
      theme: theme.entry,
      background: theme.background,
    }),
  )
  let activeVariant = resolveVariant(input.variant, session.variant, savedVariant, variants)
  let aborting = false

  const footer = new RunFooter(renderer, {
    ...footerLabels({
      agent: input.agent,
      model: input.model,
      variant: activeVariant,
    }),
    first: session.first,
    history: session.history,
    theme,
    keybinds,
    onCycleVariant: () => {
      if (!input.model || variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      activeVariant = cycleVariant(activeVariant, variants)
      saveVariant(input.model, activeVariant)
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

  void modelTask.then((info) => {
    variants = info.variants
    limits = info.limits

    const next = resolveVariant(input.variant, session.variant, savedVariant, variants)
    if (next === activeVariant) {
      return
    }

    activeVariant = next
    if (!input.model || footer.isClosed) {
      return
    }

    footer.patch({
      model: formatModelLabel(input.model, activeVariant),
    })
  })

  const sigint = () => {
    footer.requestExit()
  }
  process.on("SIGINT", sigint)

  try {
    let includeFiles = true
    await runPromptQueue({
      footer,
      initialInput: input.initialInput,
      run: async (prompt, signal) => {
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
            limits,
            footer,
            signal,
          })
          includeFiles = false
        } catch (error) {
          if (signal.aborted || footer.isClosed) {
            return
          }
          footer.append({ kind: "error", text: formatUnknownError(error), phase: "start", source: "system" })
        }
      },
    })
  } finally {
    process.off("SIGINT", sigint)

    if (!renderer.isDestroyed) {
      const hasMessages = !(await resolveFirstPrompt(input.sdk, input.sessionID))
      if (hasMessages) {
        queueSplash(
          renderer,
          state,
          "exit",
          exitSplash({
            ...meta,
            theme: theme.entry,
            background: theme.background,
          }),
        )
        await renderer.idle().catch(() => {})
      }
    }

    footer.close()
    footer.destroy()
    shutdown(renderer)
  }
}
