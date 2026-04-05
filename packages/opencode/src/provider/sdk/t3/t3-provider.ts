import type { LanguageModelV3 } from "@ai-sdk/provider"
import { withoutTrailingSlash } from "@ai-sdk/provider-utils"
import { T3LanguageModel } from "./t3-language-model"

export type T3ProviderSettings = {
  name?: string
  baseURL?: string
  apiKey?: string
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

export interface T3Provider {
  (modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

export function createT3(options: T3ProviderSettings = {}): T3Provider {
  const baseURL = withoutTrailingSlash(options.baseURL ?? "https://t3.chat") || "https://t3.chat"

  const provider = function (modelId: string) {
    return new T3LanguageModel({
      provider: `${options.name ?? "t3"}.chat`,
      modelId,
      baseURL,
      cookie: options.cookie ?? options.apiKey,
      convexSessionId: options.convexSessionId,
      hcaptchaToken: options.hcaptchaToken,
      includeSearch: options.includeSearch,
      reasoningEffort: options.reasoningEffort,
      timezone: options.timezone,
      locale: options.locale,
      headers: options.headers,
      fetch: options.fetch,
    })
  }

  provider.languageModel = provider

  return provider
}
