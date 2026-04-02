import type { Event, ToolPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../../util/locale"
import type { StreamCommit } from "./types"

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

type PartKind = "assistant" | "reasoning"

export type SessionCommit = StreamCommit

export type SessionData = {
  ids: Set<string>
  tools: Set<string>
  announced: boolean
  text: Map<string, string>
  sent: Map<string, number>
  part: Map<string, PartKind>
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
    text: new Map(),
    sent: new Map(),
    part: new Map(),
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

export function flushPart(
  data: SessionData,
  commits: SessionCommit[],
  partID: string,
  end: boolean,
  interrupted: boolean = false,
) {
  const kind = data.part.get(partID)
  if (!kind) return

  const text = data.text.get(partID) ?? ""
  const sent = data.sent.get(partID) ?? 0
  const chunk = text.slice(sent)
  if (chunk) {
    data.sent.set(partID, text.length)
    commits.push({
      kind: kind === "assistant" ? "assistant" : "reasoning",
      text: chunk,
      phase: "progress",
      source: kind,
      partID,
    })
  }

  if (!end && !interrupted) return

  commits.push({
    kind: kind === "assistant" ? "assistant" : "reasoning",
    text: interrupted ? `[${kind}:interrupted]` : `[${kind}:end]`,
    phase: "final",
    source: kind,
    partID,
  })
}

export function flushInterrupted(data: SessionData, commits: SessionCommit[]) {
  for (const partID of data.part.keys()) {
    if (!data.ids.has(partID)) {
      flushPart(data, commits, partID, false, true)
    }
  }
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

    if (event.properties.field !== "text") {
      return out(data, commits)
    }

    const partID = event.properties.partID
    if (data.ids.has(partID)) {
      return out(data, commits)
    }

    const current = data.text.get(partID) ?? ""
    data.text.set(partID, current + event.properties.delta)

    const kind = data.part.get(partID)
    if (kind) {
      flushPart(data, commits, partID, false)
    }

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
      commits.push({
        kind: "tool",
        text: `[tool:${part.tool}] ${toolStatus(part)}`,
        phase: "start",
        source: "tool",
        partID: part.id,
        tool: part.tool,
      })
      return out(data, commits, toolStatus(part))
    }

    if (part.type === "tool" && part.state.status === "completed") {
      data.tools.delete(part.id)
      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      data.ids.add(part.id)

      const output = part.state.output
      if (typeof output === "string" && output.trim()) {
        commits.push({
          kind: "tool",
          text: output,
          phase: "progress",
          source: "tool",
          partID: part.id,
          tool: part.tool,
        })
      }

      commits.push({
        kind: "tool",
        text: `[tool:${part.tool}:end]`,
        phase: "final",
        source: "tool",
        partID: part.id,
        tool: part.tool,
      })

      return out(data, commits)
    }

    if (part.type === "tool" && part.state.status === "error") {
      data.tools.delete(part.id)
      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      data.ids.add(part.id)
      const errorText = part.state.error ?? "unknown error"
      commits.push({
        kind: "tool",
        text: `[tool:${part.tool}:error] ${errorText}`,
        phase: "final",
        source: "tool",
        partID: part.id,
        tool: part.tool,
      })

      return out(data, commits)
    }

    if (part.type === "text" || part.type === "reasoning") {
      if (data.ids.has(part.id)) {
        return out(data, commits)
      }

      if (part.type === "reasoning" && !input.thinking) {
        if (part.time?.end) {
          data.ids.add(part.id)
          data.text.delete(part.id)
        }
        return out(data, commits)
      }

      const kind = part.type === "text" ? "assistant" : "reasoning"
      const wasKnown = data.part.has(part.id)
      if (!wasKnown) {
        data.part.set(part.id, kind)
        commits.push({
          kind: kind === "assistant" ? "assistant" : "reasoning",
          text: `[${kind}]`,
          phase: "start",
          source: kind,
          partID: part.id,
        })
      }

      data.text.set(part.id, part.text)
      flushPart(data, commits, part.id, !!part.time?.end)

      if (part.time?.end) {
        data.ids.add(part.id)
        data.part.delete(part.id)
        data.text.delete(part.id)
        data.sent.delete(part.id)
      }

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
      phase: "start",
      source: "system",
    })
    return out(data, commits)
  }

  return out(data, commits)
}
