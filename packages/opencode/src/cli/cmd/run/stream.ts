import path from "path"
import type { OpencodeClient, ToolPart } from "@opencode-ai/sdk/v2"
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
  footer: FooterApi
}

function normalizePath(input?: string): string {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

function formatToolTitle(part: ToolPart): string {
  const state = part.state as {
    input?: Record<string, unknown>
    title?: string
  }
  const input = state.input

  if (part.tool === "bash" && typeof input?.command === "string") {
    return `$ ${input.command}`
  }

  if ((part.tool === "read" || part.tool === "write" || part.tool === "edit") && typeof input?.filePath === "string") {
    return `${part.tool} ${normalizePath(input.filePath)}`
  }

  if (part.tool === "glob" && typeof input?.pattern === "string") {
    return `glob ${input.pattern}`
  }

  if (part.tool === "grep" && typeof input?.pattern === "string") {
    return `grep ${input.pattern}`
  }

  if (part.tool === "webfetch" && typeof input?.url === "string") {
    return `webfetch ${input.url}`
  }

  if (part.tool === "skill" && typeof input?.name === "string") {
    return `skill ${input.name}`
  }

  if (part.tool === "task") {
    if (typeof input?.description === "string" && input.description.trim()) {
      return `task ${input.description}`
    }
    if (typeof input?.subagent_type === "string" && input.subagent_type.trim()) {
      return `task ${input.subagent_type}`
    }
  }

  if (typeof state.title === "string" && state.title.trim()) {
    return `${part.tool} ${state.title}`
  }

  if (input && typeof input === "object" && Object.keys(input).length > 0) {
    return `${part.tool} ${JSON.stringify(input)}`
  }

  return part.tool
}

function formatToolOutput(part: ToolPart): string | undefined {
  const state = part.state as {
    output?: unknown
    input?: {
      todos?: {
        content: string
        status: string
      }[]
    }
  }
  if (typeof state.output === "string" && state.output.trim().length > 0) {
    return state.output.trimEnd()
  }

  if (part.tool !== "todowrite") {
    return
  }

  const todos = state.input?.todos
  if (!Array.isArray(todos) || todos.length === 0) {
    return
  }

  return todos.map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.content}`).join("\n")
}

function formatSessionError(error: {
  name: string
  data?: {
    message?: string
  }
}): string {
  if (error.data?.message) {
    return String(error.data.message)
  }
  return String(error.name)
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
  const abort = new AbortController()
  const events = await input.sdk.event.subscribe(undefined, {
    signal: abort.signal,
  })
  const seen = new Set<string>()
  const runningTasks = new Set<string>()
  let announcedAssistant = false

  const watch = (async () => {
    try {
      for await (const event of events.stream) {
        if (input.footer.isClosed) {
          break
        }

        if (
          event.type === "message.updated" &&
          event.properties.sessionID === input.sessionID &&
          event.properties.info.role === "assistant" &&
          !announcedAssistant
        ) {
          input.footer.append("system", `${event.properties.info.agent} · ${event.properties.info.modelID}`)
          input.footer.patch({
            phase: "running",
            status: "assistant responding",
          })
          announcedAssistant = true
        }

        if (event.type === "message.part.updated") {
          const part = event.properties.part
          if (part.sessionID !== input.sessionID) continue

          if (
            part.type === "tool" &&
            part.tool === "task" &&
            part.state.status === "running" &&
            runningTasks.has(part.id) === false
          ) {
            runningTasks.add(part.id)
            const state = part.state as {
              input?: { description?: string; subagent_type?: string }
            }
            const description = state.input?.description?.trim() || state.input?.subagent_type?.trim() || "task"
            input.footer.append("tool", `running ${description}`)
          }

          if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
            if (seen.has(part.id)) continue
            seen.add(part.id)

            if (part.state.status === "error") {
              input.footer.append("error", `${part.tool} failed\n${part.state.error}`)
              continue
            }

            const title = formatToolTitle(part)
            const output = formatToolOutput(part)
            input.footer.append("tool", output ? `${title}\n${output}` : title)
            continue
          }

          if (part.type === "text" && part.time?.end) {
            if (seen.has(part.id)) continue
            seen.add(part.id)
            const text = part.text.trim()
            if (!text) continue
            input.footer.append("assistant", text)
            continue
          }

          if (part.type === "reasoning" && part.time?.end && input.thinking) {
            if (seen.has(part.id)) continue
            seen.add(part.id)
            const text = part.text.trim()
            if (!text) continue
            input.footer.append("system", `Thinking: ${text}`)
            continue
          }
        }

        if (event.type === "session.error") {
          if (event.properties.sessionID !== input.sessionID || !event.properties.error) continue
          input.footer.append("error", formatSessionError(event.properties.error))
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
          input.footer.append(
            "system",
            `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
          )
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
    await input.sdk.session.prompt({
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      parts: [...(input.includeFiles ? input.files : []), { type: "text", text: input.prompt }],
    })

    await watch
  } catch (error) {
    abort.abort()
    await watch.catch(() => {})
    throw error
  } finally {
    abort.abort()
  }
}
