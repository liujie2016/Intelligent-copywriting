"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "sonner"
import { imageCompletion } from "@/lib/openai"
import { readLS, writeLS } from "@/lib/storage"
import type { ApiProfiles, ImageItem, ModelConfig, PromptItem, TaskResult } from "@/lib/types"
import { useSearchParams } from "next/navigation"

function genId() {
  try {
    // @ts-ignore
    if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID()
  } catch {}
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={[
        "flex min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        props.className || "",
      ].join(" ")}
    />
  )
}

function usePersistentState<T>(key: string, fallback: T) {
  const [state, setState] = useState<T>(() => readLS<any>(key as any, fallback))
  useEffect(() => { writeLS<any>(key as any, state) }, [key, state])
  return [state, setState] as const
}

export const ImagesWorkbench = () => {
  // 读取共享数据
  const [apiProfiles, setApiProfiles] = usePersistentState<Partial<ApiProfiles>>("apiProfiles", { image: undefined })
  const [prompts] = usePersistentState<PromptItem[]>("prompts", [])
  const [results] = usePersistentState<TaskResult[]>("results", [])
  const [images, setImages] = usePersistentState<ImageItem[]>("images", [])

  // 本页状态
  const [selectedPromptId, setSelectedPromptId] = useState<string | undefined>(undefined)
  const [promptText, setPromptText] = useState("")
  const [linkResultId, setLinkResultId] = useState<string | "">("")
  const [running, setRunning] = useState(false)
  // 图库多选
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set())
  // 新增：生成数量
  const [imageCount, setImageCount] = usePersistentState<number>("imageCount", 1)

  const imageModel = apiProfiles.image

  // 通过 URL 预填（/images?text=xxx&resultId=yyy）
  const searchParams = useSearchParams()
  useEffect(() => {
    const t = searchParams.get("text")
    const rid = searchParams.get("resultId")
    if (t) setPromptText((prev) => (prev ? prev + "\n\n" + t : t))
    if (rid) setLinkResultId(rid)
  }, [])

  const mergedPrompt = useMemo(() => {
    const sel = prompts.find((p) => p.id === selectedPromptId)
    return [sel?.content || "", promptText || ""].filter(Boolean).join("\n\n")
  }, [selectedPromptId, promptText, prompts])

  const fillFromResult = (id: string) => {
    if (!id) return
    const r = results.find((x) => x.id === id)
    if (!r) return
    const text = r.writeOutput || r.raw || ""
    setPromptText((prev) => (prev ? prev + "\n\n" + text : text))
  }

  const handleGenerate = async () => {
    if (!imageModel) { toast.error("请先在写作页的设置中配置‘图像生成 API'"); return }
    const finalPrompt = mergedPrompt.trim()
    if (!finalPrompt) { toast.error("请先填写 Prompt"); return }
    setRunning(true)
    try {
      const count = Math.max(1, Math.min(4, Number(imageCount) || 1))
      const allUrls: string[] = []
      // 先尝试一次调用，若已满足数量则直接使用；否则循环补足
      const first = await imageCompletion({ config: imageModel as ModelConfig, prompt: finalPrompt })
      allUrls.push(...first)
      while (allUrls.length < count) {
        const more = await imageCompletion({ config: imageModel as ModelConfig, prompt: finalPrompt })
        allUrls.push(...more)
        if (more.length === 0) break
      }
      const urls = allUrls.slice(0, count)
      if (!urls.length) { toast.error("未生成图片"); return }
      const items: ImageItem[] = urls.map((u) => ({ id: genId(), prompt: finalPrompt, url: u, linkedResultId: linkResultId || undefined, createdAt: Date.now() }))
      setImages((prev) => [...items, ...prev])
      toast.success(`已生成 ${items.length} 张图片`)
      // 清理选择的单条结果关联，但保留 prompt 方便继续生成
      setLinkResultId("")
    } catch (e: any) {
      toast.error(e?.message || String(e))
    } finally {
      setRunning(false)
    }
  }

  const downloadOne = async (url: string) => {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `image_${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)
    } catch {
      // CORS 或跨域受限时，直接打开原链接触发浏览器下载/查看
      const a = document.createElement("a")
      a.href = url
      a.download = `image_${Date.now()}.png`
      a.target = "_blank"
      a.rel = "noreferrer"
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }

  const toggleSelect = (id: string) =>
    setSelectedImageIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectAllImages = (on: boolean) => setSelectedImageIds(on ? new Set(images.map((i) => i.id)) : new Set())
  const deleteSelectedImages = () => {
    if (!selectedImageIds.size) return
    setImages((prev) => prev.filter((i) => !selectedImageIds.has(i.id)))
    setSelectedImageIds(new Set())
    toast.success("已删除所选图片")
  }
  const downloadSelectedImages = async () => {
    if (!selectedImageIds.size) return
    const list = images.filter((i) => selectedImageIds.has(i.id))
    for (const it of list) {
      await downloadOne(it.url)
    }
  }

  return (
    <main className="relative mx-auto max-w-6xl p-8 md:p-10 space-y-8 min-h-screen">
      <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">图像生成</h1>
      <p className="text-sm text-muted-foreground -mt-4">独立页面：自定义 Prompt 或选择模板，选择是否引用某条文案内容，调用兼容 OpenAI 的图像生成接口。</p>

      <Tabs defaultValue="compose">
        <TabsList className="grid w-full grid-cols-3 rounded-xl bg-secondary/60 p-1 backdrop-blur ring-1 ring-white/30 shadow-sm">
          <TabsTrigger value="compose">生成</TabsTrigger>
          <TabsTrigger value="gallery">图库</TabsTrigger>
          <TabsTrigger value="settings">设置</TabsTrigger>
        </TabsList>

        <TabsContent value="compose" className="space-y-6">
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border">
            <CardHeader>
              <CardTitle>选择/编写 Prompt</CardTitle>
              <CardDescription>可选一个模板并追加你的描述；也可直接纯手写。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>选择模板（可选）</Label>
                  <Select value={selectedPromptId} onValueChange={setSelectedPromptId}>
                    <SelectTrigger>
                      <SelectValue placeholder="不使用模板" />
                    </SelectTrigger>
                    <SelectContent>
                      {prompts
                        .filter((p) => p.category === "图像生成" || p.category === "自定义" || p.category === "文案生成")
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>引用一条文案作为补充（可选）</Label>
                  <Select value={linkResultId} onValueChange={(v) => { setLinkResultId(v); if (v) fillFromResult(v) }}>
                    <SelectTrigger>
                      <SelectValue placeholder="不引用" />
                    </SelectTrigger>
                    <SelectContent>
                      {results
                        .slice()
                        .sort((a,b)=>a.index-b.index)
                        .map((r, i) => (
                          <SelectItem key={r.id} value={r.id}>{`文案${i+1}`}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <Label>最终 Prompt（可编辑）</Label>
                  <Textarea value={mergedPrompt} onChange={(e) => setPromptText(e.target.value)} placeholder="描述你希望生成的封面图风格与要素..." className="min-h-[160px]" />
                  <p className="text-xs text-muted-foreground mt-2">提示：模板内容 + 你追加的内容将合并为最终 Prompt。</p>
                </div>
                <div>
                  <Label>生成数量（1-4）</Label>
                  <Input type="number" min={1} max={4} value={imageCount}
                    onChange={(e) => setImageCount(Math.max(1, Math.min(4, Number(e.target.value) || 1)))} />
                  <p className="text-xs text-muted-foreground mt-1">设置为1即生成单张；{'&gt;'}1 将批量生成多张。</p>
                </div>
              </div>
              <div className="flex gap-3">
                <Button onClick={handleGenerate} disabled={running}>{running ? "生成中..." : "生成图片"}</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="gallery" className="space-y-6">
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border">
            <CardHeader>
              <CardTitle>已生成的图片</CardTitle>
              <CardDescription>最新生成的图片会显示在最前面。可下载或删除。</CardDescription>
            </CardHeader>
            <CardContent>
              {!images.length && <p className="text-muted-foreground">暂无图片</p>}
              {!!images.length && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 bg-white/40 dark:bg-white/5">
                    <div className="flex items-center gap-2">
                      <input
                        id="gallerySelectAll"
                        type="checkbox"
                        checked={selectedImageIds.size > 0 && selectedImageIds.size === images.length}
                        onChange={(e) => selectAllImages(e.target.checked)}
                      />
                      <Label htmlFor="gallerySelectAll">全选（{selectedImageIds.size}/{images.length}）</Label>
                    </div>
                    <Button size="sm" variant="secondary" onClick={downloadSelectedImages} disabled={!selectedImageIds.size}>批量下载</Button>
                    <Button size="sm" variant="destructive" onClick={deleteSelectedImages} disabled={!selectedImageIds.size}>批量删除</Button>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {images
                      .slice()
                      .sort((a,b)=>b.createdAt - a.createdAt)
                      .map((img) => (
                        <div key={img.id} className="border rounded-md overflow-hidden bg-white/50 dark:bg-white/5">
                          <img
                            src={img.url}
                            alt={img.prompt.slice(0,50)}
                            className="w-full aspect-square object-cover"
                          />
                          <div className="p-2 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs line-clamp-2" title={img.prompt}>{img.prompt}</div>
                              <input type="checkbox" checked={selectedImageIds.has(img.id)} onChange={() => toggleSelect(img.id)} />
                            </div>
                            <a href={img.url} target="_blank" rel="noreferrer" className="block text-[11px] text-blue-600 underline break-all line-clamp-2">{img.url}</a>
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="secondary" onClick={() => downloadOne(img.url)}>下载</Button>
                              <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(img.url).then(()=>toast.success("已复制链接")).catch(()=>{})}>复制链接</Button>
                              <Button size="sm" variant="destructive" onClick={() => setImages(prev => prev.filter(x => x.id !== img.id))}>删除</Button>
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border">
            <CardHeader>
              <CardTitle>图像生成 API（OpenAI 兼容）</CardTitle>
              <CardDescription>设置 Base URL、API Key 和模型名。与聊天接口同一生态时可直接通用。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label>Base URL</Label>
                  <Input placeholder="https://api.openai.com" value={apiProfiles.image?.baseUrl || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, image: { ...(p.image || { name: "image" } as any), baseUrl: e.target.value } as any }))} />
                </div>
                <div>
                  <Label>API Key</Label>
                  <Input placeholder="sk-..." value={apiProfiles.image?.apiKey || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, image: { ...(p.image || { name: "image" } as any), apiKey: e.target.value } as any }))} />
                </div>
                <div>
                  <Label>模型名</Label>
                  <Input placeholder="e.g. gpt-image-1 或 provider 的图像模型" value={apiProfiles.image?.model || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, image: { ...(p.image || { name: "image" } as any), model: e.target.value } as any }))} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">说明：优先使用 /v1/images/generations；若服务端统一到 chat 接口，将自动回退解析结果中的图片 URL。</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  )
}

export default ImagesWorkbench