export function splitNumberedBlocks(input: string): { index: number; text: string }[] {
  // 支持：1. 2) 3） 4、 中文/英文句点或括号，行首编号，或以换行分隔的粗略段落
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: { index: number; text: string }[] = [];
  let current: string[] = [];
  let currentIndex = 1;

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) blocks.push({ index: blocks.length + 1, text });
    current = [];
  };

  const numberRegex = /^(\s*)(\d{1,3})([\.|。|\)|）|、|\-]{1})\s*/; // 1. 1) 1） 1、 1- 等

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const m = line.match(numberRegex);
    if (m) {
      // 新编号开始
      if (current.length) flush();
      currentIndex = parseInt(m[2], 10) || currentIndex + 1;
      current.push(line.replace(numberRegex, "").trim());
    } else {
      current.push(line);
    }
  }
  flush();

  // 如果没有检测到编号且只有一个非空块，返回一个整体块
  if (blocks.length === 1 && !/^\s*\d+[\.|。|\)|）|、|\-]/m.test(input)) {
    return [{ index: 1, text: input.trim() }];
  }

  // 清理空块与重编号
  const cleaned = blocks
    .map((b) => ({ ...b, text: b.text.trim() }))
    .filter((b) => b.text.length > 0)
    .map((b, i) => ({ index: i + 1, text: b.text }));

  return cleaned;
}

// 过滤带"thinking/思考/推理"过程文本：更激进且多形态匹配
export function stripThinking(raw: string): string {
  if (!raw) return "";

  let text = raw;

  // 1) 移除各种思考代码块
  text = text.replace(/```(?:thinking|think|thought|thoughts|analysis|reasoning)[\s\S]*?```/gi, "");
  text = text.replace(/<\/?(?:think|thinking|analysis|reasoning)>[\s\S]*?<\/(?:think|thinking|analysis|reasoning)>/gi, "");
  // DeepSeek 风格 XML 标签（容错写法）
  text = text.replace(/<\s*(?:think|thinking|analysis|reasoning)[^>]*>[\s\S]*?<\s*\/\s*(?:think|thinking|analysis|reasoning)\s*>/gi, "");

  // 2) 去除以 Thinking/思考/推理 开头的前置段（含星标形式）
  const thinkingHeadRegex = /^(?:\s*(?:\*+\s*)?(?:thinking|thoughts?|analysis|reasoning|思考|推理|想法)[:：\.\-]*\s*\n[\s\S]*?)(?=\n{2,}|$)/gim;
  text = text.replace(thinkingHeadRegex, "");

  // 3) 去掉连续的引用型"推理前言"块（行首 > 或者是被 markdown 引用的解释）
  const lines = text.split(/\n/);
  const out: string[] = [];
  let inPreamble = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const isQuote = /^\s*>/.test(l);
    // 简化并更安全的元信息行检测：以项目符号或编号开头
    const looksLikeMeta = /^\s*(?:[\*\-–—>]|\d+[\.\)）])\s*\*?\*?[A-Za-z\u4e00-\u9fa5].*\*?\*?\s*$/.test(l);
    const hasThinkingKeyword = /(thinking|thoughts?|analysis|reasoning|思考|推理|步骤|计划|分解)/i.test(l);

    if (inPreamble) {
      if (isQuote || hasThinkingKeyword || looksLikeMeta || l.trim() === "") {
        // 丢弃这些前置说明性/推理性行
        continue;
      }
      // 第一条看起来是正文的行
      inPreamble = false;
      out.push(l);
    } else {
      out.push(l);
    }
  }
  text = out.join("\n");

  // 4) 清理遗留的单行标签，例如 *Thinking...*, [Thinking], 【思考】 等
  text = text
    .replace(/^\s*\*+\s*(thinking|thoughts?|analysis|reasoning|思考|推理)[^\n]*$/gim, "")
    .replace(/^\s*[\[【\(]?(thinking|thoughts?|analysis|reasoning|思考|推理)[\]】\)]?[:：]?[^\n]*$/gim, "");

  // 5) 合并多余空行并修剪
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}