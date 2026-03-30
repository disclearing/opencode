import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { createSessionData, reduceSessionData } from "./session-data"
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
  } catch (error) {
    input.signal?.removeEventListener("abort", stop)
    throw error
  }
  const stream = events.stream as unknown as {
    return?: (value?: unknown) => Promise<unknown>
  }
  const close = () => {
    if (typeof stream.return === "function") {
      void stream.return().catch(() => {})
    }
  }
  let data = createSessionData()

  const watch = (async () => {
    try {
      for await (const item of events.stream) {
        if (input.footer.isClosed) {
          break
        }

        const event = item as Event
        const next = reduceSessionData({
          data,
          event,
          sessionID: input.sessionID,
          thinking: input.thinking,
          limits: input.limits,
        })
        data = next.data

        for (const commit of next.commits) {
          input.footer.append(commit.kind, commit.text)
        }

        if (next.status) {
          input.footer.patch({
            phase: "running",
            status: next.status,
          })
        }

        if (next.usage) {
          input.footer.patch({
            usage: next.usage,
          })
        }

        if (
          event.type === "session.status" &&
          event.properties.sessionID === input.sessionID &&
          event.properties.status.type === "idle"
        ) {
          break
        }

        if (event.type === "permission.asked") {
          const permission = event.properties
          if (permission.sessionID !== input.sessionID) continue
          await input.sdk.permission.reply({
            requestID: permission.id,
            reply: "reject",
          })
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        throw error
      }
    }
  })()

  try {
    await input.sdk.session.prompt(
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
        parts: [...(input.includeFiles ? input.files : []), { type: "text", text: input.prompt }],
      },
      {
        signal: abort.signal,
      },
    )

    if (abort.signal.aborted) {
      return
    }

    if (!input.footer.isClosed && !data.announced) {
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
      void watch.catch(() => {})
      return
    }

    await watch.catch(() => {})
    throw error
  } finally {
    close()
    input.signal?.removeEventListener("abort", stop)
    abort.abort()
  }
}
