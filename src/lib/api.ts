import { DEFAULT_GEMINI_MODEL, DEFAULT_GROK_MODEL, getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { callGeminiChatImageApi, resumeGeminiChatImageTask } from './geminiChatImageApi'
import { callOpenAICompatibleImageApi, resumeOpenAICompatibleImageTask } from './openaiCompatibleImageApi'
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
  if (opts.settings.imageEngine === 'grok') {
    return callOpenAICompatibleImageApi(opts, {
      ...profile,
      provider: 'grok',
      name: 'Grok',
      model: DEFAULT_GROK_MODEL,
      apiMode: 'images',
      codexCli: false,
      apiProxy: true,
      responseFormatB64Json: undefined,
    }, null)
  }
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}

export async function resumeImageApiTask(opts: CallApiOptions, pollUrl: string): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (opts.settings.imageEngine === 'gemini') {
    return resumeGeminiChatImageTask(opts, {
      ...profile,
      provider: 'gemini',
      name: 'Gemini',
      model: DEFAULT_GEMINI_MODEL,
      apiMode: 'images',
      codexCli: false,
      responseFormatB64Json: undefined,
    }, pollUrl)
  }
  if (opts.settings.imageEngine === 'grok') {
    return resumeOpenAICompatibleImageTask(opts, {
      ...profile,
      provider: 'grok',
      name: 'Grok',
      model: DEFAULT_GROK_MODEL,
      apiMode: 'images',
      codexCli: false,
      apiProxy: true,
      responseFormatB64Json: undefined,
    }, pollUrl)
  }
  return resumeOpenAICompatibleImageTask(opts, profile, pollUrl)
}
