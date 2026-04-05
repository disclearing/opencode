import type { Hooks, PluginInput } from "@opencode-ai/plugin"

function cookieValue(raw: string, key: string) {
  for (const part of raw.split(";")) {
    const item = part.trim()
    if (!item) continue
    const i = item.indexOf("=")
    if (i === -1) continue
    if (item.slice(0, i).trim() !== key) continue
    return item.slice(i + 1).trim()
  }
}

export async function T3AuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "t3",
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || auth.type !== "api") return {}

        // When users previously pasted captcha token into primary auth,
        // avoid treating it as cookie.
        if (!auth.key.includes("=")) {
          return {}
        }

        return {
          cookie: auth.key,
          convexSessionId: cookieValue(auth.key, "convex-session-id"),
        }
      },
      methods: [
        {
          type: "api",
          label: "Paste t3.chat cookie",
          prompts: [
            {
              type: "text",
              key: "cookie",
              message: "Paste your full Cookie header from t3.chat (set T3_HCAPTCHA_TOKEN if checkpointed)",
              placeholder: "name=value; convex-session-id=...; ...",
              validate: (value) => (value && value.includes("=") ? undefined : "Cookie header is required"),
            },
          ],
          async authorize(inputs = {}) {
            const cookie = inputs.cookie?.trim()
            if (!cookie) return { type: "failed" as const }
            return {
              type: "success" as const,
              key: cookie,
            }
          },
        },
        {
          type: "api",
          label: "Paste hCaptcha token",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "Paste your hCaptcha token from t3.chat /api/chat payload",
              placeholder: "P1_...",
              validate: (value) =>
                value && value.startsWith("P1_") ? undefined : "hCaptcha token must start with P1_",
            },
          ],
          async authorize(inputs = {}) {
            const token = inputs.token?.trim()
            if (!token) return { type: "failed" as const }
            return {
              type: "success" as const,
              provider: "t3-hcaptcha",
              key: token,
            }
          },
        },
      ],
    },
  }
}
