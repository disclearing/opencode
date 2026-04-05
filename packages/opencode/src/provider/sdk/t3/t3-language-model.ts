import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"

type Role = "user" | "assistant"

type Msg = {
  id: string
  role: Role
  parts: Array<{
    type: "text"
    text: string
  }>
  attachments: []
}

type Cfg = {
  provider: string
  modelId: string
  baseURL: string
  cookie?: string
  convexSessionId?: string
  hcaptchaToken?: string
  includeSearch?: boolean
  reasoningEffort?: "low" | "medium" | "high"
  timezone?: string
  locale?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
}

function cookieValue(raw: string | undefined, key: string) {
  if (!raw) return
  for (const part of raw.split(";")) {
    const item = part.trim()
    if (!item) continue
    const i = item.indexOf("=")
    if (i === -1) continue
    const k = item.slice(0, i).trim()
    if (k !== key) continue
    return item.slice(i + 1).trim()
  }
}

function t3Msgs(prompt: LanguageModelV3Prompt): Msg[] {
  const out: Msg[] = []
  for (const msg of prompt) {
    if (msg.role === "system") {
      out.push({
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text: `[system]\n${msg.content}` }],
        attachments: [],
      })
      continue
    }

    if (msg.role === "tool") {
      const text = msg.content
        .map((part) => {
          if (part.type === "tool-approval-response") return ""
          if (part.output.type === "text" || part.output.type === "error-text") return part.output.value
          if (part.output.type === "execution-denied") return part.output.reason ?? "execution denied"
          return JSON.stringify(part.output.value)
        })
        .filter(Boolean)
        .join("\n")
      if (!text) continue
      out.push({
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text: `[tool]\n${text}` }],
        attachments: [],
      })
      continue
    }

    const parts = msg.content
      .map((part) => {
        if (part.type === "text") return part.text
        if (part.type === "reasoning") return part.text ?? ""
        if (part.type === "tool-call") return `[tool-call ${part.toolName}] ${JSON.stringify(part.input)}`
        if (part.type === "file") return `[file ${part.mediaType}]`
        return ""
      })
      .filter(Boolean)
      .join("\n")

    out.push({
      id: generateId(),
      role: msg.role,
      parts: [{ type: "text", text: parts }],
      attachments: [],
    })
  }

  return out
}

function textDelta(value: unknown) {
  if (!value || typeof value !== "object") return ""
  const item = value as Record<string, unknown>
  if (typeof item.delta === "string") return item.delta
  if (item.delta && typeof item.delta === "object") {
    const delta = item.delta as Record<string, unknown>
    if (typeof delta.text === "string") return delta.text
  }
  if (typeof item.text === "string") return item.text
  if (typeof item.content === "string") return item.content
  if (Array.isArray(item.content)) {
    return item.content
      .map((x) => {
        if (!x || typeof x !== "object") return ""
        const part = x as Record<string, unknown>
        return typeof part.text === "string" ? part.text : ""
      })
      .join("")
  }
  return ""
}

function sseLines(chunk: string) {
  return chunk
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
}

function isCheckpoint(status: number, body: string) {
  if (status !== 429) return false
  if (!body) return false
  return body.includes("Security Checkpoint") || body.includes("<html")
}

function fail(status: number, body: string, hasToken: boolean) {
  if (isCheckpoint(status, body)) {
    return new Error(
      [
        "t3 request blocked by Security Checkpoint (429)",
        "refresh your t3.chat session cookie and hCaptcha token (run /connect for t3: Paste t3.chat cookie, then Paste hCaptcha token)",
      ].join(": "),
    )
  }
  if (status === 400 && body.includes("captcha_failed")) {
    if (hasToken) {
      return new Error("t3 captcha token was sent but rejected (likely expired); refresh and reconnect hCaptcha token")
    }
    return new Error("t3 captcha token missing; run /connect for t3 and choose Paste hCaptcha token")
  }
  const text = body.replaceAll("\n", " ").trim().slice(0, 240)
  return new Error(`t3 request failed (${status}): ${text}`)
}

function upsertCookie(raw: string, key: string, value: string) {
  const next = raw
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith(`${key}=`))
  next.push(`${key}=${value}`)
  return next.join("; ")
}

function usage() {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
    },
    raw: undefined,
  }
}

export class T3LanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  private cookie?: string

  constructor(private cfg: Cfg) {
    this.cookie = cfg.cookie
  }

  get provider() {
    return this.cfg.provider
  }

  get modelId() {
    return this.cfg.modelId
  }

  get supportedUrls() {
    return {}
  }

  private body(options: LanguageModelV3CallOptions) {
    const cookie = this.cookie
    const convex = this.cfg.convexSessionId ?? cookieValue(cookie, "convex-session-id")
    if (!cookie) throw new Error("t3 provider requires cookie")
    if (!convex) throw new Error("t3 provider requires convexSessionId or convex-session-id cookie")

    const thread =
      (typeof options.headers?.["x-session-affinity"] === "string" && options.headers["x-session-affinity"]) ||
      generateId()

    return {
      req: {
        messages: t3Msgs(options.prompt),
        threadMetadata: { id: thread },
        responseMessageId: generateId(),
        model: this.cfg.modelId,
        convexSessionId: convex,
        modelParams: {
          reasoningEffort: this.cfg.reasoningEffort ?? "low",
          includeSearch: this.cfg.includeSearch ?? false,
        },
        preferences: {
          name: "",
          occupation: "",
          selectedTraits: [],
          additionalInfo: "",
        },
        userInfo: {
          timezone: this.cfg.timezone ?? "UTC",
          locale: this.cfg.locale ?? "en-US",
        },
        ...(this.cfg.hcaptchaToken ? { hcaptchaToken: this.cfg.hcaptchaToken } : {}),
      },
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        cookie,
        origin: "https://t3.chat",
        referer: `https://t3.chat/chat/${thread}`,
        priority: "u=1, i",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Linux"',
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
        "x-client-context":
          "eyJjbGllbnQiOnsidmVyc2lvbiI6IjEuMTIuNCJ9LCJpbnRlZ3JpdHkiOnsidiI6dHJ1ZSwiYzIiOiJ1bnZlcmlmaWVkIn19",
        ...(cookieValue(cookie, "__vdpl") ? { "x-deployment-id": cookieValue(cookie, "__vdpl") } : {}),
        ...this.cfg.headers,
      },
    }
  }

  private async refresh(signal?: AbortSignal) {
    if (!this.cookie) return
    const fetcher = this.cfg.fetch ?? fetch
    const res = await fetcher(
      "https://t3.chat/api/trpc/auth.getActiveSessions?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22includeLocation%22%3Afalse%7D%7D%7D",
      {
        method: "GET",
        headers: {
          cookie: this.cookie,
          "content-type": "application/json",
          "trpc-accept": "application/jsonl",
          accept: "*/*",
          origin: "https://t3.chat",
          referer: "https://t3.chat/",
        },
        signal,
      },
    )
    const session = res.headers.get("x-workos-session")
    if (!session) return
    this.cookie = upsertCookie(this.cookie, "wos-session", session)
  }

  private async send(options: LanguageModelV3CallOptions) {
    await this.refresh(options.abortSignal).catch(() => undefined)
    const { req, headers } = this.body(options)
    const fetcher = this.cfg.fetch ?? fetch
    const res = await fetcher(`${this.cfg.baseURL}/api/chat`, {
      method: "POST",
      headers: {
        ...headers,
        ...options.headers,
      },
      body: JSON.stringify(req),
      signal: options.abortSignal,
    })
    const raw = await res.text()
    if (!res.ok) throw fail(res.status, raw, Boolean(req.hcaptchaToken))
    return {
      req,
      res,
      raw,
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    const { req, res, raw } = await this.send(options)

    let text = ""
    for (const line of sseLines(raw)) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") break
      const parsed = JSON.parse(data)
      text += textDelta(parsed)
    }

    const content: LanguageModelV3Content[] = [{ type: "text", text }]
    return {
      content,
      finishReason: {
        unified: "stop" as const,
        raw: "stop",
      },
      usage: usage(),
      warnings: [],
      request: {
        body: JSON.stringify(req),
      },
      response: {
        headers: Object.fromEntries(res.headers.entries()),
        body: raw,
      },
      providerMetadata: {
        t3: {},
      },
    }
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const { req, res, raw } = await this.send(options)

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(raw))
        ctrl.close()
      },
    })

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(ctrl) {
        ctrl.enqueue({ type: "stream-start", warnings: [] })

        const decoder = new TextDecoder()
        const reader = body.getReader()
        let buf = ""
        let opened = false

        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            buf += decoder.decode(part.value, { stream: true })

            while (true) {
              const idx = buf.indexOf("\n")
              if (idx === -1) break
              const line = buf.slice(0, idx).trim()
              buf = buf.slice(idx + 1)
              if (!line || !line.startsWith("data:")) continue

              const data = line.slice(5).trim()
              if (options.includeRawChunks) {
                ctrl.enqueue({
                  type: "raw",
                  rawValue: data,
                })
              }
              if (data === "[DONE]") {
                buf = ""
                break
              }

              let value: unknown
              try {
                value = JSON.parse(data)
              } catch {
                continue
              }

              const delta = textDelta(value)
              if (!delta) continue

              if (!opened) {
                opened = true
                ctrl.enqueue({ type: "text-start", id: "txt-0" })
              }
              ctrl.enqueue({ type: "text-delta", id: "txt-0", delta })
            }
          }

          if (opened) {
            ctrl.enqueue({ type: "text-end", id: "txt-0" })
          }

          ctrl.enqueue({
            type: "finish",
            finishReason: {
              unified: "stop",
              raw: "stop",
            },
            usage: usage(),
            providerMetadata: {
              t3: {},
            },
          })
          ctrl.close()
        } catch (error) {
          ctrl.enqueue({ type: "error", error })
          ctrl.enqueue({
            type: "finish",
            finishReason: {
              unified: "error",
              raw: "error",
            },
            usage: usage(),
            providerMetadata: {
              t3: {},
            },
          })
          ctrl.close()
        }
      },
    })

    return {
      stream,
      request: {
        body: JSON.stringify(req),
      },
      response: {
        headers: Object.fromEntries(res.headers.entries()),
      },
    }
  }
}
