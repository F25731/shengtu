import type { ApiProfile, TaskParams } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import {
  assertImageInputPayloadSize,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
} from './imageApiShared'
import { createCardsHeaderValue } from './cardClient'

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

type GeminiChatContent =
  | string
  | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >

function createRequestHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
    'X-YunYi-Cards': createCardsHeaderValue(),
  }
}

function createGeminiContent(prompt: string, inputImageDataUrls: string[]): GeminiChatContent {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [
    { type: 'text', text },
    ...inputImageDataUrls.map((url) => ({
      type: 'image_url' as const,
      image_url: { url },
    })),
  ]
}

function getMimeFromDataUrl(dataUrl: string, fallbackMime: string): string {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/i)
  return match?.[1] || fallbackMime
}

function getFormatFromMime(mime: string): TaskParams['output_format'] | undefined {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg'
  if (mime === 'image/webp') return 'webp'
  return undefined
}

function collectUnknownValues(source: unknown, values: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (source == null || seen.has(source)) return values
  if (typeof source === 'string') {
    values.push(source)
    return values
  }
  if (typeof source !== 'object') return values
  seen.add(source)

  if (Array.isArray(source)) {
    for (const item of source) collectUnknownValues(item, values, seen)
    return values
  }

  for (const value of Object.values(source as Record<string, unknown>)) {
    collectUnknownValues(value, values, seen)
  }
  return values
}

function extractDataUrlsFromText(text: string): string[] {
  const urls: string[] = []
  const dataUrlPattern = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/g
  for (const match of text.matchAll(dataUrlPattern)) {
    urls.push(`data:${match[1]};base64,${match[2].replace(/\s/g, '')}`)
  }
  return urls
}

function extractHttpImageUrlsFromText(text: string): string[] {
  const urls: string[] = []
  const markdownPattern = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g
  for (const match of text.matchAll(markdownPattern)) urls.push(match[1])

  const directPattern = /(https?:\/\/[^\s"'<>)]*\.(?:png|jpe?g|webp)(?:\?[^\s"'<>)]*)?)/gi
  for (const match of text.matchAll(directPattern)) urls.push(match[1])
  return [...new Set(urls)]
}

async function parseGeminiChatResponse(payload: unknown, fallbackMime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const strings = collectUnknownValues(payload).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  const dataUrls = strings.flatMap(extractDataUrlsFromText)
  const rawImageUrls = strings.flatMap(extractHttpImageUrlsFromText)
  const images: string[] = []

  for (const dataUrl of dataUrls) {
    images.push(normalizeBase64Image(dataUrl, fallbackMime))
  }

  for (const url of rawImageUrls) {
    if (!images.some((image) => image.includes(url))) {
      images.push(await fetchImageUrlAsDataUrl(url, fallbackMime, signal))
    }
  }

  if (!images.length) {
    const err = new Error('Gemini 接口没有返回可识别的图片数据，请查看原始响应确认中转站返回结构。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const firstMime = getMimeFromDataUrl(images[0], fallbackMime)
  const actualParams = mergeActualParams(
    pickActualParams(payload),
    {
      n: images.length,
      ...(getFormatFromMime(firstMime) ? { output_format: getFormatFromMime(firstMime) } : {}),
    },
  )

  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts: images.map(() => undefined),
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

async function callGeminiChatImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt, params, inputImageDataUrls, maskDataUrl } = opts
  if (maskDataUrl) {
    throw new Error('Gemini 暂不支持遮罩局部编辑，请切换到 ChatGPT 后再使用遮罩。')
  }

  assertImageInputPayloadSize(inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0))

  const fallbackMime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

  try {
    const body = {
      model: profile.model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: createGeminiContent(prompt, inputImageDataUrls),
        },
      ],
    }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'chat/completions', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: {
        ...createRequestHeaders(profile),
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    return parseGeminiChatResponse(await response.json(), fallbackMime, controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callGeminiChatImageApiConcurrent(opts: CallApiOptions, profile: ApiProfile, n: number): Promise<CallApiResult> {
  const singleOpts = { ...opts, params: { ...opts.params, n: 1 } }
  const results = await Promise.allSettled(
    Array.from({ length: n }).map(() => callGeminiChatImageApiSingle(singleOpts, profile)),
  )
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<CallApiResult> => result.status === 'fulfilled')
    .map((result) => result.value)

  if (!successfulResults.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (firstError) throw firstError.reason
    throw new Error('所有 Gemini 请求均失败')
  }

  const images = successfulResults.flatMap((result) => result.images)
  const actualParamsList = successfulResults.flatMap((result) =>
    result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((result) =>
    result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((result) => result.rawImageUrls ?? [])
  const actualParams = mergeActualParams(successfulResults[0]?.actualParams, { n: images.length })

  return { images, actualParams, actualParamsList, revisedPrompts, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

export async function callGeminiChatImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n > 1) return callGeminiChatImageApiConcurrent(opts, profile, n)
  return callGeminiChatImageApiSingle(opts, profile)
}
