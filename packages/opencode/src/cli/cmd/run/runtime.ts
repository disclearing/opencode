import path from "path"
import { createCliRenderer, type CliRenderer, type ScrollbackWriter } from "@opentui/core"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { TuiConfig } from "../../../config/tui"
import { Global } from "../../../global"
import { Filesystem } from "../../../util/filesystem"
import { Locale } from "../../../util/locale"
import { RunFooter } from "./footer"
import { entrySplash, exitSplash, splashMeta } from "./splash"
import { createSessionTransport, formatUnknownError } from "./stream.transport"
import { resolveRunTheme } from "./theme"
import { trace } from "./trace"
import type { FooterApi, FooterEvent, FooterKeybinds, RunDiffStyle, RunInput } from "./types"

const FOOTER_HEIGHT = 7
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

async function resolveDiffStyle(): Promise<RunDiffStyle> {
  try {
    const config = await TuiConfig.get()
    return config.diff_style ?? "auto"
  } catch {
    return "auto"
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
  const log = trace()
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

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    log?.write("ui.patch", row)
    input.footer.event(next)
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

        emit(
          {
            type: "turn.send",
            queue: q.length,
          },
          {
            phase: "running",
            status: "sending prompt",
            queue: q.length,
          },
        )
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
          const commit = { kind: "user", text, phase: "start", source: "system" } as const
          log?.write("ui.commit", commit)
          input.footer.append(commit)
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
          const duration = Locale.duration(Math.max(0, Date.now() - start))
          emit(
            {
              type: "turn.duration",
              duration,
            },
            {
              duration,
            },
          )
        }
      }
    } finally {
      run = false
      emit(
        {
          type: "turn.idle",
          queue: q.length,
        },
        {
          phase: "idle",
          status: "",
          queue: q.length,
        },
      )
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
    emit(
      {
        type: "queue",
        queue: q.length,
      },
      {
        queue: q.length,
      },
    )
    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
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

type BootContext = Pick<RunInput, "sdk" | "sessionID" | "sessionTitle" | "agent" | "model" | "variant">

type RunRuntimeInput = {
  boot: () => Promise<BootContext>
  afterPaint?: (ctx: BootContext) => Promise<void> | void
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

async function runInteractiveRuntime(input: RunRuntimeInput): Promise<void> {
  const keybindsTask = resolveFooterKeybinds()
  const diffTask = resolveDiffStyle()
  const ctx = await input.boot()
  const modelTask = resolveModelInfo(ctx.sdk, ctx.model)
  const sessionTask = resolveSessionInfo(ctx.sdk, ctx.sessionID, ctx.model)
  const savedTask = resolveSavedVariant(ctx.model)
  const state: SplashState = {
    entry: false,
    exit: false,
  }
  let variants: string[] = []
  let limits: Record<string, number> = {}
  let activeVariant: string | undefined
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
  const theme = await resolveRunTheme(renderer)
  renderer.setBackgroundColor(theme.background)
  const [keybinds, diffStyle, session, savedVariant] = await Promise.all([
    keybindsTask,
    diffTask,
    sessionTask,
    savedTask,
  ])
  const meta = splashMeta({
    title: splashTitle(ctx.sessionTitle, session.history),
    session_id: ctx.sessionID,
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
  activeVariant = resolveVariant(ctx.variant, session.variant, savedVariant, variants)

  const footer = new RunFooter(renderer, {
    ...footerLabels({
      agent: ctx.agent,
      model: ctx.model,
      variant: activeVariant,
    }),
    first: session.first,
    history: session.history,
    theme,
    keybinds,
    diffStyle,
    onCycleVariant: () => {
      if (!ctx.model || variants.length === 0) {
        return {
          status: "no variants available",
        }
      }

      activeVariant = cycleVariant(activeVariant, variants)
      saveVariant(ctx.model, activeVariant)
      return {
        status: activeVariant ? `variant ${activeVariant}` : "variant default",
        modelLabel: formatModelLabel(ctx.model, activeVariant),
      }
    },
    onInterrupt: () => {
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

  if (input.afterPaint) {
    void Promise.resolve(input.afterPaint(ctx)).catch(() => {})
  }

  void modelTask.then((info) => {
    variants = info.variants
    limits = info.limits

    const next = resolveVariant(ctx.variant, session.variant, savedVariant, variants)
    if (next === activeVariant) {
      return
    }

    activeVariant = next
    if (!ctx.model || footer.isClosed) {
      return
    }

    footer.event({
      type: "model",
      model: formatModelLabel(ctx.model, activeVariant),
    })
  })

  const sigint = () => {
    footer.requestExit()
  }
  process.on("SIGINT", sigint)

  try {
    let includeFiles = true
    const stream = await createSessionTransport({
      sdk: ctx.sdk,
      sessionID: ctx.sessionID,
      thinking: input.thinking,
      limits: () => limits,
      footer,
    })

    try {
      await runPromptQueue({
        footer,
        initialInput: input.initialInput,
        run: async (prompt, signal) => {
          try {
            await stream.runPromptTurn({
              agent: ctx.agent,
              model: ctx.model,
              variant: activeVariant,
              prompt,
              files: input.files,
              includeFiles,
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
      await stream.close()
    }
  } finally {
    process.off("SIGINT", sigint)

    if (!renderer.isDestroyed) {
      const hasMessages = !(await resolveFirstPrompt(ctx.sdk, ctx.sessionID))
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

export async function runInteractiveLocalMode(input: RunLocalInput): Promise<void> {
  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: input.fetch,
  })

  return runInteractiveRuntime({
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
        agent,
        model: input.model,
        variant: input.variant,
      }
    },
  })
}

export async function runInteractiveMode(input: RunInput): Promise<void> {
  return runInteractiveRuntime({
    files: input.files,
    initialInput: input.initialInput,
    thinking: input.thinking,
    boot: async () => ({
      sdk: input.sdk,
      sessionID: input.sessionID,
      sessionTitle: input.sessionTitle,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
    }),
  })
}
