// 「客资助手」对话式录入路由
// 端点：POST /customerapi/customers/agent/chat   SSE 流式对话（识别 + 查重 + 引导确认）
// 设计:
//   - SSE 全程：text_delta / tool_call / pending_import / done / error 几种事件
//   - LLM 只读不写：commit 由前端调 /batch-import
//   - 复用 ai.js 的限流与管理員拦截策略
const express = require('express');
const router = express.Router();
const config = require('../config');
const authRequired = require('../middleware/auth');
const { httpError } = require('../middleware/errorHandler');
const { sse } = require('../utils/sse');
const { streamChat } = require('../utils/llmClient');
const { TOOLS, executeToolCall } = require('../utils/agentTools');
const AGENT_SYSTEM_PROMPT = require('../utils/agentSystemPrompt');
// ── 内存限流（与 ai.js 同一套窗口/上限配置，桶各自独立）────────
const rateLimitStore = new Map();
function checkRateLimit(userId) {
  const now = Date.now() / 1000;
  const window = config.AI_RATE_LIMIT_WINDOW;
  const maxCalls = config.AI_RATE_LIMIT_MAX;
  const arr = (rateLimitStore.get(userId) || []).filter((t) => now - t < window);
  if (arr.length >= maxCalls) throw httpError(429, '请求过于频繁，请稍后再试');
  arr.push(now);
  rateLimitStore.set(userId, arr);
}
// ── POST /chat（SSE）──────────────────────────────────────
// 请求体：{ messages: OpenAI 格式[], image_base64?: string }
// SSE 事件：text_delta / tool_call / pending_import / tool_result / done / error
router.post('/chat', authRequired, async (req, res, next) => {
  // ── 前置校验：全部在开 SSE 之前完成，失败走正常 HTTP 状态码 ──
  try {
    checkRateLimit(req.user.id);
  } catch (e) {
    return next(e);
  }
  if (req.user.role === 'admin') {
    return next(httpError(403, '管理员账号仅可查看，不支持录入'));
  }
  const userMessages = Array.isArray((req.body || {}).messages) ? req.body.messages : [];
  const pendingImage = (req.body || {}).image_base64 || null;
  if (userMessages.length > 200) {
    return next(httpError(422, 'messages 长度不能超过 200'));
  }
  if (pendingImage) {
    const buf = Buffer.from(pendingImage, 'base64');
    if (buf.length > 5 * 1024 * 1024) return next(httpError(422, '图片大小不能超过 5MB'));
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const isPng = buf.slice(0, 8).equals(pngSig);
    if (!isJpeg && !isPng) return next(httpError(422, '仅支持 JPEG/PNG 格式图片'));
  }
  const messages = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
  for (const m of userMessages) {
    if (!m || typeof m !== 'object') continue;
    // 不放行 system：系统提示词只能由服务端注入，防提示词注入
    if (!['user', 'assistant', 'tool'].includes(m.role)) continue;
    messages.push(m);
  }
  if (pendingImage) {
    const last = messages[messages.length - 1];
    const text = (last && last.role === 'user' && typeof last.content === 'string')
      ? last.content
      : '请识别这张截图中的联系人';
    const userMsg = {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${pendingImage}` } },
        { type: 'text', text },
      ],
    };
    if (last && last.role === 'user') messages[messages.length - 1] = userMsg;
    else messages.push(userMsg);
  }

  // ── 开启 SSE ──────────────────────────────────────────
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const abortController = new AbortController();
  let closed = false;
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 30000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    abortController.abort();
  };
  req.on('close', cleanup);
  const safeWrite = (evt) => {
    if (closed) return false;
    try { res.write(sse(evt)); return true; } catch (_) { return false; }
  };
  const finish = (evt) => {
    clearInterval(heartbeat);
    safeWrite(evt);
    res.end();
  };
  const userId = req.user.id;
  let iter = 0;
  while (iter < config.LLM_MAX_TOOL_ITER) {
    iter++;
    let assistantContent = '';
    let assistantToolCalls = null;
    let finishReason = null;
    try {
      const stream = await streamChat({ messages, tools: TOOLS, signal: abortController.signal });
      for await (const evt of stream) {
        if (closed) return;
        if (evt.type === 'text') {
          assistantContent += evt.delta;
          safeWrite({ type: 'text_delta', delta: evt.delta });
        } else if (evt.type === 'tool_call') {
          assistantToolCalls = evt.toolCalls || [];
          finishReason = evt.finishReason || 'tool_calls';
        } else if (evt.type === 'finish') {
          finishReason = finishReason || evt.finishReason || 'stop';
        }
      }
    } catch (e) {
      clearInterval(heartbeat);
      if (closed || abortController.signal.aborted) return;
      return finish({ type: 'error', message: e.message || 'AI 调用失败' });
    }
    if (closed) return;
    // 构造 assistant 消息。为避免 fallback id 与 tool_call_id 不一致，
    // 我们给每个 tc 注入 __finalId（优先用 M3 返回的，否则本地生成），
    // 后面的 tool 响应、上一轮下发的 tool_call 事件全部用同一个 id。
    const assistantMsg = { role: 'assistant' };
    if (assistantToolCalls && assistantToolCalls.length > 0) {
      assistantMsg.content = assistantContent || null;
      assistantMsg.tool_calls = assistantToolCalls.map((tc, i) => {
        const tid = tc.id || `call_${iter}_${i}_${Date.now()}`;
        tc.__finalId = tid;
        return {
          id: tid,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        };
      });
      safeWrite({
        type: 'tool_call',
        tool_calls: assistantToolCalls.map((tc) => ({ id: tc.__finalId, name: tc.name, args: tc.args })),
      });
    } else {
      assistantMsg.content = assistantContent;
    }
    messages.push(assistantMsg);
    if (!assistantToolCalls || assistantToolCalls.length === 0) {
      return finish({ type: 'done', reason: finishReason });
    }
    let allOk = true;
    for (const tc of assistantToolCalls) {
      let toolResult;
      try {
        toolResult = executeToolCall({
          userId,
          name: tc.name,
          args: tc.args || {},
          emit: safeWrite,
        });
      } catch (e) {
        toolResult = { error: e.message || '工具执行失败' };
        allOk = false;
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.__finalId,
        content: JSON.stringify(toolResult),
      });
      safeWrite({ type: 'tool_result', name: tc.name, content: toolResult });
    }
    if (closed) return;
    if (!allOk) {
      return finish({ type: 'done', reason: 'tool_error' });
    }
  }
  finish({ type: 'done', reason: 'max_iter' });
});
module.exports = router;
