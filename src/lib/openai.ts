import type { ModelConfig } from "./types"

export type ChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type ChatOptions = {
  config: ModelConfig
  messages: ChatMessage[]
  signal?: AbortSignal
  extraHeaders?: Record<string, string>
}

export async function chatCompletion({ config, messages, signal, extraHeaders }: ChatOptions): Promise<string> {
  const { baseUrl, apiKey, model } = config
  // 兼容：baseUrl 既可以是根地址(https://api.xxx.com)，也可以直接是完整的 completions 接口地址
  const base = (baseUrl || "").trim()
  const isFullEndpoint = /\/v1\/chat\/completions(?:\/?$|\?)/.test(base)
  const url = isFullEndpoint
    ? base
    : `${base.replace(/\/$/, "")}/v1/chat/completions`

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({
      model,
      messages,
      // 不设置 max_tokens，尊重服务端默认与超大上下文模型
      stream: false,
      temperature: 0.7,
    }),
    signal,
  })

  // 先处理非 2xx
  if (!res.ok) {
    const t = await safeText(res)
    throw new Error(`ChatCompletion failed: ${res.status} ${res.statusText} ${t}`)
  }

  // 再校验返回类型，避免 HTML 导致 JSON 解析异常（Unexpected token '<'）
  const ct = (res.headers.get("content-type") || "").toLowerCase()
  if (!ct.includes("application/json")) {
    const t = await safeText(res)
    throw new Error(`服务端返回非 JSON（${ct || "unknown"}）。请检查 Base URL 是否正确，或代理是否将 HTML 错误页返回给了客户端。片段：${t.slice(0, 200)}`)
  }

  // 最后安全解析 JSON
  try {
    const json = await res.json()
    const content: string = json?.choices?.[0]?.message?.content ?? ""
    return content
  } catch (err) {
    const t = await safeText(res)
    throw new Error(`解析返回失败：${String(err)}。原始片段：${t.slice(0, 200)}`)
  }
}

export async function listModels(config: ModelConfig): Promise<string[]> {
  const url = new URL("/v1/models", config.baseUrl).toString()
  const res = await fetch(url, {
    headers: {
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
  })
  if (!res.ok) return []
  const data = await res.json()
  const models: string[] = data?.data?.map((m: any) => m.id).filter(Boolean) ?? []
  return models
}

// 新增：图像生成（兼容 OpenAI /v1/images/generations，也兼容"与聊天一致"的统一接口返回）
export type ImageGenOptions = {
  config: ModelConfig
  prompt: string
  signal?: AbortSignal
  extraHeaders?: Record<string, string>
}

export async function imageCompletion({ config, prompt, signal, extraHeaders }: ImageGenOptions): Promise<string[]> {
  const base = (config.baseUrl || "").trim()
  const imagesUrl = `${base.replace(/\/$/, "")}/v1/images/generations`
  const chatUrl = `${base.replace(/\/$/, "")}/v1/chat/completions`

  // 优先尝试标准 images 接口
  try {
    const res = await fetch(imagesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(extraHeaders || {}),
      },
      body: JSON.stringify({
        model: config.model,
        prompt,
        n: 1,
        size: "1024x1024",
        response_format: "url", // 服务端可能返回 url 或 b64_json
      }),
      signal,
    })

    if (res.ok) {
      const json = await res.json()
      const items: any[] = json?.data || []
      const urls = items
        .map((it) => it?.url || (it?.b64_json ? `data:image/png;base64,${it.b64_json}` : ""))
        .filter(Boolean)
      if (urls.length) return urls
    }
  } catch {}

  // 回退：部分服务商将图像生成统一到 chat 接口，内容里返回 URL 或 base64
  const content = await chatCompletion({
    config,
    messages: [
      { role: "system", content: "You are an image generation API. Return ONLY the direct image URL or base64 data URL." },
      { role: "user", content: prompt },
    ],
    signal,
    extraHeaders,
  })

  // 尝试从文本中提取 URL 或 data URL
  const urls = extractImageUrls(content)
  if (urls.length) return urls
  // 如果没有可用 URL，则将全文作为 data URL（可能为 base64 片段）
  if (/^data:image\//.test(content.trim())) return [content.trim()]
  throw new Error("未从返回中解析到图片链接，请检查服务端返回格式或更换 response_format")
}

function extractImageUrls(text: string): string[] {
  const urls = new Set<string>()
  const s = String(text || "")

  // 1) Markdown 图片语法 ![alt](url)
  const mdImg = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m: RegExpExecArray | null
  while ((m = mdImg.exec(s))) {
    if (m[1]) urls.add(m[1])
  }

  // 2) Markdown 链接 [text](url)
  const mdLink = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  while ((m = mdLink.exec(s))) {
    if (m[1]) urls.add(m[1])
  }

  // 3) HTML <img src="...">
  const htmlImg = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  while ((m = htmlImg.exec(s))) {
    if (m[1]) urls.add(m[1])
  }

  // 4) data URL 直接返回
  const dataUrlRe = /data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+/gi
  while ((m = dataUrlRe.exec(s))) {
    if (m[0]) urls.add(m[0])
  }

  // 5) 普通 URL 扫描（包含 query/hash 等）
  const urlRe = /(https?:\/\/[\w.-]+(?:\/[\w\-._~:\/?#\[\]@!$&'()*+,;=%]*)?)/gi
  while ((m = urlRe.exec(s))) {
    if (m[1]) urls.add(m[1])
  }

  // 基于启发式过滤非图片链接（但保留常见无扩展的 CDN 签名地址）
  const isProbablyImageUrl = (u: string) => {
    if (/^data:image\//.test(u)) return true
    if (/\.(png|jpg|jpeg|webp|gif)(?:\?.*)?$/i.test(u)) return true
    // 查询参数提示为图片
    if (/(?:image|format|ext)=(?:png|jpg|jpeg|webp|gif)/i.test(u)) return true
    // 常见图片 CDN 迹象
    if (/(?:images|img|media|cdn)\//i.test(u)) return true
    return false
  }

  const list = Array.from(urls)
    .filter((u) => isProbablyImageUrl(u))

  // 如果过滤后为空，仍然回退为所有 http(s) 链接，交由前端兜底展示为链接
  return list.length ? Array.from(new Set(list)) : Array.from(new Set(Array.from(urls)))
}

async function safeText(res: Response) {
  try { return await res.text() } catch { return "" }
}