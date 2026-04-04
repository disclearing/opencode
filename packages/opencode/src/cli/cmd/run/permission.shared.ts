import os from "os"
import path from "path"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Locale } from "../../../util/locale"
import type { PermissionReply } from "./types"

type Dict = Record<string, unknown>

export type PermissionStage = "permission" | "always" | "reject"
export type PermissionOption = "once" | "always" | "reject" | "confirm" | "cancel"

export type PermissionBodyState = {
  requestID: string
  stage: PermissionStage
  selected: PermissionOption
  message: string
  submitting: boolean
}

export type PermissionInfo = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  file?: string
}

export type PermissionStep = {
  state: PermissionBodyState
  reply?: PermissionReply
}

function dict(v: unknown): Dict {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {}
  }

  return v as Dict
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

export function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const home = os.homedir()
  const abs = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const rel = path.relative(cwd, abs)

  if (!rel) return "."
  if (!rel.startsWith("..")) return rel
  if (home && (abs === home || abs.startsWith(home + path.sep))) {
    return abs.replace(home, "~")
  }

  return abs
}

function data(request: PermissionRequest): Dict {
  const meta = dict(request.metadata)
  return {
    ...meta,
    ...dict(meta.input),
  }
}

function patterns(request: PermissionRequest): string[] {
  return request.patterns.filter((item): item is string => typeof item === "string")
}

export function createPermissionBodyState(requestID: string): PermissionBodyState {
  return {
    requestID,
    stage: "permission",
    selected: "once",
    message: "",
    submitting: false,
  }
}

export function permissionOptions(stage: PermissionStage): PermissionOption[] {
  if (stage === "permission") {
    return ["once", "always", "reject"]
  }

  if (stage === "always") {
    return ["confirm", "cancel"]
  }

  return []
}

export function permissionInfo(request: PermissionRequest): PermissionInfo {
  const input = data(request)

  if (request.permission === "edit") {
    const file = text(input.filepath) || patterns(request)[0] || ""
    return {
      icon: "→",
      title: `Edit ${normalizePath(file)}`,
      lines: [],
      diff: text(input.diff),
      file,
    }
  }

  if (request.permission === "read") {
    const file = text(input.filePath) || patterns(request)[0] || ""
    return {
      icon: "→",
      title: `Read ${normalizePath(file)}`,
      lines: file ? [`Path: ${normalizePath(file)}`] : [],
    }
  }

  if (request.permission === "glob") {
    const pattern = text(input.pattern) || patterns(request)[0] || ""
    return {
      icon: "✱",
      title: `Glob "${pattern}"`,
      lines: pattern ? [`Pattern: ${pattern}`] : [],
    }
  }

  if (request.permission === "grep") {
    const pattern = text(input.pattern) || patterns(request)[0] || ""
    return {
      icon: "✱",
      title: `Grep "${pattern}"`,
      lines: pattern ? [`Pattern: ${pattern}`] : [],
    }
  }

  if (request.permission === "list") {
    const dir = text(input.path) || patterns(request)[0] || ""
    return {
      icon: "→",
      title: `List ${normalizePath(dir)}`,
      lines: dir ? [`Path: ${normalizePath(dir)}`] : [],
    }
  }

  if (request.permission === "bash") {
    const title = text(input.description) || "Shell command"
    const cmd = text(input.command)
    return {
      icon: "#",
      title,
      lines: cmd ? [`$ ${cmd}`] : patterns(request).map((item) => `- ${item}`),
    }
  }

  if (request.permission === "task") {
    const type = text(input.subagent_type) || "general"
    const desc = text(input.description)
    return {
      icon: "#",
      title: `${Locale.titlecase(type)} Task`,
      lines: desc ? [`◉ ${desc}`] : [],
    }
  }

  if (request.permission === "webfetch") {
    const url = text(input.url)
    return {
      icon: "%",
      title: `WebFetch ${url}`,
      lines: url ? [`URL: ${url}`] : [],
    }
  }

  if (request.permission === "websearch") {
    const query = text(input.query)
    return {
      icon: "◈",
      title: `Exa Web Search "${query}"`,
      lines: query ? [`Query: ${query}`] : [],
    }
  }

  if (request.permission === "codesearch") {
    const query = text(input.query)
    return {
      icon: "◇",
      title: `Exa Code Search "${query}"`,
      lines: query ? [`Query: ${query}`] : [],
    }
  }

  if (request.permission === "external_directory") {
    const meta = dict(request.metadata)
    const raw = text(meta.parentDir) || text(meta.filepath) || patterns(request)[0] || ""
    const dir = raw.includes("*") ? raw.slice(0, raw.indexOf("*")).replace(/[\\/]+$/, "") : raw
    return {
      icon: "←",
      title: `Access external directory ${normalizePath(dir)}`,
      lines: patterns(request).map((item) => `- ${item}`),
    }
  }

  if (request.permission === "doom_loop") {
    return {
      icon: "⟳",
      title: "Continue after repeated failures",
      lines: ["This keeps the session running despite repeated failures."],
    }
  }

  return {
    icon: "⚙",
    title: `Call tool ${request.permission}`,
    lines: [`Tool: ${request.permission}`],
  }
}

export function permissionAlwaysLines(request: PermissionRequest): string[] {
  if (request.always.length === 1 && request.always[0] === "*") {
    return [`This will allow ${request.permission} until OpenCode is restarted.`]
  }

  return [
    "This will allow the following patterns until OpenCode is restarted.",
    ...request.always.map((item) => `- ${item}`),
  ]
}

export function permissionLabel(option: PermissionOption): string {
  if (option === "once") return "Allow once"
  if (option === "always") return "Allow always"
  if (option === "reject") return "Reject"
  if (option === "confirm") return "Confirm"
  return "Cancel"
}

export function permissionReply(requestID: string, reply: PermissionReply["reply"], message?: string): PermissionReply {
  return {
    requestID,
    reply,
    ...(message && message.trim() ? { message: message.trim() } : {}),
  }
}

export function permissionShift(state: PermissionBodyState, dir: -1 | 1): PermissionBodyState {
  const list = permissionOptions(state.stage)
  if (list.length === 0) {
    return state
  }

  const idx = Math.max(0, list.indexOf(state.selected))
  const selected = list[(idx + dir + list.length) % list.length]
  return {
    ...state,
    selected,
  }
}

export function permissionHover(state: PermissionBodyState, option: PermissionOption): PermissionBodyState {
  return {
    ...state,
    selected: option,
  }
}

export function permissionRun(state: PermissionBodyState, requestID: string, option: PermissionOption): PermissionStep {
  if (state.submitting) {
    return { state }
  }

  if (state.stage === "permission") {
    if (option === "always") {
      return {
        state: {
          ...state,
          stage: "always",
          selected: "confirm",
        },
      }
    }

    if (option === "reject") {
      return {
        state: {
          ...state,
          stage: "reject",
          selected: "reject",
        },
      }
    }

    return {
      state,
      reply: permissionReply(requestID, "once"),
    }
  }

  if (state.stage !== "always") {
    return { state }
  }

  if (option === "cancel") {
    return {
      state: {
        ...state,
        stage: "permission",
        selected: "always",
      },
    }
  }

  return {
    state,
    reply: permissionReply(requestID, "always"),
  }
}

export function permissionReject(state: PermissionBodyState, requestID: string): PermissionReply | undefined {
  if (state.submitting) {
    return
  }

  return permissionReply(requestID, "reject", state.message)
}

export function permissionCancel(state: PermissionBodyState): PermissionBodyState {
  return {
    ...state,
    stage: "permission",
    selected: "reject",
  }
}

export function permissionEscape(state: PermissionBodyState): PermissionBodyState {
  if (state.stage === "always") {
    return {
      ...state,
      stage: "permission",
      selected: "always",
    }
  }

  return {
    ...state,
    stage: "reject",
    selected: "reject",
  }
}
