import path from "path"
import { Global } from "../../../global"
import { Filesystem } from "../../../util/filesystem"
import type { RunInput } from "./types"

const MODEL_FILE = path.join(Global.Path.state, "model.json")

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

export function formatModelLabel(model: NonNullable<RunInput["model"]>, variant: string | undefined): string {
  const label = variant ? ` · ${variant}` : ""
  return `${model.modelID} · ${model.providerID}${label}`
}

export function cycleVariant(current: string | undefined, variants: string[]): string | undefined {
  if (variants.length === 0) {
    return undefined
  }

  if (!current) {
    return variants[0]
  }

  const idx = variants.indexOf(current)
  if (idx === -1 || idx === variants.length - 1) {
    return undefined
  }

  return variants[idx + 1]
}

export function pickVariant(model: RunInput["model"], messages: SessionMessages): string | undefined {
  if (!model || !messages || messages.length === 0) {
    return undefined
  }

  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const info = messages[idx]?.info
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

export async function resolveSavedVariant(model: RunInput["model"]): Promise<string | undefined> {
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

export function saveVariant(model: RunInput["model"], variant: string | undefined): void {
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
