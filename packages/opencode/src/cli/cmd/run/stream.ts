import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { createSessionData, reduceSessionData, flushInterrupted, type SessionCommit } from "./session-data"
import { trace } from "./trace"
import type { FooterApi, RunFilePart, RunInput } from "./types"

type TurnInput = {
  sdk: OpencodeClient
  sessionID: string
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  prompt: string
  files: RunFilePart[]
  includeFiles: boolean
  thinking: boolean
  limits: Record<string, number>
  footer: FooterApi
  signal?: AbortSignal
}

export function formatUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error
  }

  if (error instanceof Error) {
    return error.message || error.name
  }

  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; name?: unknown }
    if (typeof candidate.message === "string" && candidate.message.trim().length > 0) {
      return candidate.message
    }
    if (typeof candidate.name === "string" && candidate.name.trim().length > 0) {
      return candidate.name
    }
  }

  return "unknown error"
}

export async function runPromptTurn(input: TurnInput): Promise<void> {
  if (input.signal?.aborted) {
    return
  }

  const log = trace()
  const abort = new AbortController()
  const stop = () => {
    abort.abort()
  }

  input.signal?.addEventListener("abort", stop, { once: true })

  let events: Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>
  try {
    events = await input.sdk.event.subscribe(undefined, {
      signal: abort.signal,
    })
    log?.write("recv.subscribe", {
      sessionID: input.sessionID,
    })
  } catch (error) {
    input.signal?.removeEventListener("abort", stop)
    throw error
  }
  const close = () => {
    // Pass undefined explicitly so TS accepts AsyncGenerator.return().
    void events.stream.return(undefined).catch(() => {})
  }
  const offPermission = input.footer.onPermissionReply(async (payload) => {
    log?.write("send.permission.reply", payload)
    await input.sdk.permission.reply(payload)
  })
  const offQuestion = input.footer.onQuestionReply(async (payload) => {
    await input.sdk.question.reply(payload)
  })
  const offReject = input.footer.onQuestionReject(async (payload) => {
    await input.sdk.question.reject(payload)
  })
  let data = createSessionData()

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
          limits: input.limits,
        })
        data = next.data

        if (next.commits.length > 0 || next.footer?.patch || next.footer?.view) {
          log?.write("reduce.output", {
            commits: next.commits,
            footer: next.footer,
          })
        }

        for (const commit of next.commits) {
          log?.write("ui.commit", commit)
          input.footer.append(commit)
        }

        if (next.footer?.patch) {
          const patch =
            typeof next.footer.patch.status === "string" && next.footer.patch.phase === undefined
              ? { phase: "running" as const, ...next.footer.patch }
              : next.footer.patch
          log?.write("ui.patch", patch)
          input.footer.patch(patch)
        }

        if (next.footer?.view) {
          log?.write("ui.patch", {
            view: next.footer.view,
          })
          input.footer.present(next.footer.view)
        }

        if (
          event.type === "session.status" &&
          event.properties.sessionID === input.sessionID &&
          event.properties.status.type === "idle"
        ) {
          break
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        throw error
      }
    }
  })()

  try {
    const req = {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      parts: [...(input.includeFiles ? input.files : []), { type: "text" as const, text: input.prompt }],
    }
    log?.write("send.prompt", req)
    await input.sdk.session.prompt(req, {
      signal: abort.signal,
    })
    log?.write("send.prompt.ok", {
      sessionID: input.sessionID,
    })

    if (abort.signal.aborted) {
      const commits: SessionCommit[] = []
      flushInterrupted(data, commits)
      for (const commit of commits) {
        log?.write("ui.commit", commit)
        input.footer.append(commit)
      }
      log?.write("turn.abort", {
        sessionID: input.sessionID,
      })
      return
    }

    if (!input.footer.isClosed && !data.announced) {
      log?.write("ui.patch", {
        phase: "running",
        status: "waiting for assistant",
      })
      input.footer.patch({
        phase: "running",
        status: "waiting for assistant",
      })
    }

    await watch
  } catch (error) {
    const canceled = abort.signal.aborted || input.signal?.aborted === true
    abort.abort()
    if (canceled) {
      close()
      const commits: SessionCommit[] = []
      flushInterrupted(data, commits)
      for (const commit of commits) {
        log?.write("ui.commit", commit)
        input.footer.append(commit)
      }
      log?.write("turn.cancel", {
        sessionID: input.sessionID,
      })
      void watch.catch(() => {})
      return
    }

    log?.write("send.prompt.error", {
      sessionID: input.sessionID,
      error: formatUnknownError(error),
    })
    await watch.catch(() => {})
    throw error
  } finally {
    log?.write("turn.end", {
      sessionID: input.sessionID,
    })
    offPermission()
    offQuestion()
    offReject()
    close()
    input.signal?.removeEventListener("abort", stop)
    abort.abort()
  }
}
