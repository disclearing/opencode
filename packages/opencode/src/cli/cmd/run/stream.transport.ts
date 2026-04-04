import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { createSessionData, flushInterrupted, reduceSessionData, type SessionData } from "./stream"
import { trace } from "./trace"
import type { FooterApi, RunFilePart, RunInput, StreamCommit } from "./types"

type StreamInput = {
  sdk: OpencodeClient
  sessionID: string
  thinking: boolean
  limits: () => Record<string, number>
  footer: FooterApi
  signal?: AbortSignal
}

type Wait = {
  tick: number
  armed: boolean
  done: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

export type SessionTurnInput = {
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  prompt: string
  files: RunFilePart[]
  includeFiles: boolean
  signal?: AbortSignal
}

export type SessionTransport = {
  runPromptTurn(input: SessionTurnInput): Promise<SessionData>
  close(): Promise<void>
}

function defer(tick: number): Wait {
  let resolve: () => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const done = new Promise<void>((next, fail) => {
    resolve = next
    reject = fail
  })

  return {
    tick,
    armed: false,
    done,
    resolve,
    reject,
  }
}

function waitTurn(done: Promise<void>, signal: AbortSignal): Promise<"idle" | "abort"> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve("abort")
      return
    }

    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      resolve("abort")
    }

    signal.addEventListener("abort", onAbort, { once: true })
    done.then(
      () => {
        signal.removeEventListener("abort", onAbort)
        resolve("idle")
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export function formatUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error
  }

  if (error instanceof Error) {
    return error.message || error.name
  }

  if (error && typeof error === "object") {
    const value = error as { message?: unknown; name?: unknown }
    if (typeof value.message === "string" && value.message.trim()) {
      return value.message
    }

    if (typeof value.name === "string" && value.name.trim()) {
      return value.name
    }
  }

  return "unknown error"
}

export async function createSessionTransport(input: StreamInput): Promise<SessionTransport> {
  const log = trace()
  const abort = new AbortController()
  const halt = () => {
    abort.abort()
  }
  input.signal?.addEventListener("abort", halt, { once: true })

  const events = await input.sdk.event.subscribe(undefined, {
    signal: abort.signal,
  })
  log?.write("recv.subscribe", {
    sessionID: input.sessionID,
  })

  const closeStream = () => {
    // Pass undefined explicitly so TS accepts AsyncGenerator.return().
    void events.stream.return(undefined).catch(() => {})
  }

  let data = createSessionData()
  let wait: Wait | undefined
  let tick = 0
  let fault: unknown
  let closed = false

  const fail = (error: unknown) => {
    if (fault) {
      return
    }

    fault = error
    const next = wait
    wait = undefined
    next?.reject(error)
  }

  const write = (commits: StreamCommit[]) => {
    for (const commit of commits) {
      log?.write("ui.commit", commit)
      input.footer.append(commit)
    }
  }

  const mark = (event: Event) => {
    if (
      event.type !== "session.status" ||
      event.properties.sessionID !== input.sessionID ||
      event.properties.status.type !== "idle"
    ) {
      return
    }

    const next = wait
    if (!next || !next.armed) {
      return
    }

    tick = next.tick + 1
    wait = undefined
    next.resolve()
  }

  const flush = (type: "turn.abort" | "turn.cancel") => {
    const commits: StreamCommit[] = []
    flushInterrupted(data, commits)
    write(commits)
    log?.write(type, {
      sessionID: input.sessionID,
    })
  }

  const watch = (async () => {
    try {
      for await (const item of events.stream) {
        if (input.footer.isClosed) {
          break
        }

        const event = item as Event
        log?.write("recv.event", event)
        const next = reduceSessionData({
          data,
          event,
          sessionID: input.sessionID,
          thinking: input.thinking,
          limits: input.limits(),
        })
        data = next.data

        if (next.commits.length > 0 || next.footer?.patch || next.footer?.view) {
          log?.write("reduce.output", {
            commits: next.commits,
            footer: next.footer,
          })
        }

        write(next.commits)

        if (next.footer?.patch) {
          const patch =
            typeof next.footer.patch.status === "string" && next.footer.patch.phase === undefined
              ? { phase: "running" as const, ...next.footer.patch }
              : next.footer.patch
          log?.write("ui.patch", patch)
          input.footer.event({
            type: "stream.patch",
            patch,
          })
        }

        if (next.footer?.view) {
          log?.write("ui.patch", {
            view: next.footer.view,
          })
          input.footer.event({
            type: "stream.view",
            view: next.footer.view,
          })
        }

        mark(event)
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        fail(error)
      }
    } finally {
      if (!abort.signal.aborted && !fault) {
        fail(new Error("session event stream closed"))
      }
      closeStream()
    }
  })()

  const runPromptTurn = async (next: SessionTurnInput): Promise<SessionData> => {
    if (next.signal?.aborted || input.footer.isClosed) {
      return data
    }

    if (fault) {
      throw fault
    }

    if (wait) {
      throw new Error("prompt already running")
    }

    const item = defer(tick)
    wait = item
    data.announced = false

    const turn = new AbortController()
    const stop = () => {
      turn.abort()
    }
    next.signal?.addEventListener("abort", stop, { once: true })
    abort.signal.addEventListener("abort", stop, { once: true })

    try {
      const req = {
        sessionID: input.sessionID,
        agent: next.agent,
        model: next.model,
        variant: next.variant,
        parts: [...(next.includeFiles ? next.files : []), { type: "text" as const, text: next.prompt }],
      }
      log?.write("send.prompt", req)
      await input.sdk.session.prompt(req, {
        signal: turn.signal,
      })
      log?.write("send.prompt.ok", {
        sessionID: input.sessionID,
      })

      item.armed = true

      if (turn.signal.aborted || next.signal?.aborted || input.footer.isClosed) {
        if (wait === item) {
          wait = undefined
        }
        flush("turn.abort")
        return data
      }

      if (!input.footer.isClosed && !data.announced) {
        log?.write("ui.patch", {
          phase: "running",
          status: "waiting for assistant",
        })
        input.footer.event({
          type: "turn.wait",
        })
      }

      if (tick > item.tick) {
        if (wait === item) {
          wait = undefined
        }
        return data
      }

      const state = await waitTurn(item.done, turn.signal)
      if (wait === item) {
        wait = undefined
      }

      if (state === "abort") {
        flush("turn.abort")
      }

      return data
    } catch (error) {
      if (wait === item) {
        wait = undefined
      }

      const canceled = turn.signal.aborted || next.signal?.aborted === true || input.footer.isClosed
      if (canceled) {
        flush("turn.cancel")
        return data
      }

      if (error === fault) {
        throw error
      }

      log?.write("send.prompt.error", {
        sessionID: input.sessionID,
        error: formatUnknownError(error),
      })
      throw error
    } finally {
      log?.write("turn.end", {
        sessionID: input.sessionID,
      })
      next.signal?.removeEventListener("abort", stop)
      abort.signal.removeEventListener("abort", stop)
    }
  }

  const close = async () => {
    if (closed) {
      return
    }

    closed = true
    input.signal?.removeEventListener("abort", halt)
    abort.abort()
    closeStream()
    await watch.catch(() => {})
  }

  return {
    runPromptTurn,
    close,
  }
}
