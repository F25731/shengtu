import { DEFAULT_GEMINI_MODEL, getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { callGeminiChatImageApi } from './geminiChatImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (opts.settings.imageEngine === 'gemini') {
    return callGeminiChatImageApi(opts, {
      ...profile,
      provider: 'gemini',
      name: 'Gemini',
      model: DEFAULT_GEMINI_MODEL,
      apiMode: 'images',
      codexCli: false,
      responseFormatB64Json: undefined,
    })
  }
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
