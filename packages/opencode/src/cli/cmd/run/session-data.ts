import type { Event, ToolPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../../util/locale"
import type { EntryKind } from "./types"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

export type SessionCommit = {
  kind: EntryKind
  text: string
}

export type SessionData = {
  ids: Set<string>
  tools: Set<string>
  announced: boolean
  delta: Map<string, string>
}

export type SessionDataInput = {
  data: SessionData
  event: Event
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}

export type SessionDataOutput = {
  data: SessionData
  commits: SessionCommit[]
  status?: string
  usage?: string
}

export function createSessionData(): SessionData {
  return {
    ids: new Set(),
    tools: new Set(),
    announced: false,
    delta: new Map(),
  }
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function formatUsage(
  tokens: Tokens | undefined,
  limit: number | undefined,
  cost: number | undefined,
): string | undefined {
  const total =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)

  if (total <= 0) {
    if (typeof cost === "number" && cost > 0) {
      return money.format(cost)
    }
    return
  }

  const text =
    limit && limit > 0 ? `${Locale.number(total)} (${Math.round((total / limit) * 100)}%)` : Locale.number(total)

  if (typeof cost === "number" && cost > 0) {
    return `${text} · ${money.format(cost)}`
  }

  return text
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

function toolStatus(part: ToolPart): string {
  if (part.tool !== "task") {
    return `running ${part.tool}`
  }

  const state = part.state as {
    input?: {
      description?: unknown
      subagent_type?: unknown
    }
  }
  const desc = state.input?.description
  if (typeof desc === "string" && desc.trim()) {
    return `running ${desc.trim()}`
  }

  const type = state.input?.subagent_type
  if (typeof type === "string" && type.trim()) {
    return `running ${type.trim()}`
  }

  return "running task"
}

function deltaKey(partID: string, field: string): string {
  return `${partID}:${field}`
}

function mergeDelta(data: SessionData, partID: string, text: string): string {
  const key = deltaKey(partID, "text")
  const delta = data.delta.get(key)
  data.delta.delete(key)

  if (text) {
    return text
  }

  return delta ?? text
}

function out(data: SessionData, commits: SessionCommit[], status?: string, usage?: string): SessionDataOutput {
  const next: SessionDataOutput = {
    data,
    commits,
  }

  if (typeof status === "string") {
    next.status = status
  }

  if (typeof usage === "string") {
    next.usage = usage
  }

  return next
}

export function reduceSessionData(input: SessionDataInput): SessionDataOutput {
  const commits: SessionCommit[] = []
  const data = input.data
  const event = input.event

  if (event.type === "message.updated") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const info = event.properties.info
    if (info.role !== "assistant") {
      return out(data, commits)
    }

    const status = data.announced ? undefined : "assistant responding"
    data.announced = true
    const usage = formatUsage(
      info.tokens,
      input.limits[modelKey(info.providerID, info.modelID)],
      typeof info.cost === "number" ? info.cost : undefined,
    )
    return out(data, commits, status, usage)
  }

  if (event.type === "message.part.delta") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (
      typeof event.properties.partID !== "string" ||
      typeof event.properties.field !== "string" ||
      typeof event.properties.delta !== "string"
    ) {
      return out(data, commits)
    }

    const key = deltaKey(event.properties.partID, event.properties.field)
    data.delta.set(key, `${data.delta.get(key) ?? ""}${event.properties.delta}`)
    return out(data, commits)
  }

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (part.type === "tool" && part.state.status === "running") {
      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      if (data.tools.has(part.id)) {
        return out(data, commits)
      }

      data.tools.add(part.id)
      return out(data, commits, toolStatus(part))
    }

    if (part.type === "tool" && part.state.status === "completed") {
      data.tools.delete(part.id)
      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      data.ids.add(part.id)
      return out(data, commits)
    }

    if (part.type === "tool" && part.state.status === "error") {
      data.tools.delete(part.id)
      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      data.ids.add(part.id)
      const text = `${part.tool}: ${part.state.error}`.trim()
      if (!text) {
        return out(data, commits)
      }

      commits.push({
        kind: "error",
        text,
      })
      return out(data, commits)
    }

    if (part.type === "text") {
      if (!part.time?.end) {
        return out(data, commits)
      }

      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      data.ids.add(part.id)
      const text = mergeDelta(data, part.id, part.text).trim()
      if (!text) {
        return out(data, commits)
      }

      commits.push({
        kind: "assistant",
        text,
      })
      return out(data, commits)
    }

    if (part.type === "reasoning") {
      if (!part.time?.end || !input.thinking) {
        return out(data, commits)
      }

      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      data.ids.add(part.id)
      const text = mergeDelta(data, part.id, part.text).trim()
      if (!text) {
        return out(data, commits)
      }

      commits.push({
        kind: "system",
        text: `Thinking: ${text}`,
      })
      return out(data, commits)
    }

    return out(data, commits)
  }

  if (event.type === "permission.asked") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    return out(
      data,
      commits,
      `permission requested: ${event.properties.permission} (${event.properties.patterns.join(", ")}); auto-rejecting`,
    )
  }

  if (event.type === "session.error") {
    if (event.properties.sessionID !== input.sessionID || !event.properties.error) {
      return out(data, commits)
    }

    commits.push({
      kind: "error",
      text: formatSessionError(event.properties.error),
    })
    return out(data, commits)
  }

  return out(data, commits)
}
