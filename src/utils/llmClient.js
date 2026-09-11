// MiniMax M3 聊天客户端（OpenAI 兼容 SSE 流式）
// 调用约束：
//   1) 支持 text + image_url 多模态输入（user.content 可为 string 或 array）
//   2) 支持 tools / function calling（流式返回的 tool_calls 按 index 累积）
//   3) 支持 thinking 控制（disabled / adaptive / enabled），默认 disabled 省 token
//   4) 流式终止：data: [DONE] 或 finish_reason 非 null
// 鉴权：Bearer LLM_API_KEY，URL/LLM_MODEL 从 config 取
const axios = require('axios');
const config = require('../config');
const { httpError } = require('../middleware/errorHandler');
// M3 的 max_completion_tokens 最低要求 16384，否则返回 400
const MIN_MAX_TOKENS = 16384;

/**
 * 发起一次 LLM 流式调用
 * @param {Object} params
 * @param {Array}  params.messages   OpenAI 格式消息数组
 * @param {Array}  [params.tools]    OpenAI 格式 tools 定义
 * @param {Object}  [params.signal]  AbortSignal，用于取消
 * @returns {Promise<{
 *   async *[Symbol.asyncIterator](): AsyncGenerator<{
 *     type: 'text'|'tool_call'|'finish'|'error',
 *     delta?: string,
 *     toolCalls?: Array<{id, name, args}>,
 *     finishReason?: string,
 *     usage?: Object
 *   }>
 * }>}
 */
async function streamChat({ messages, tools, signal } = {}) {
  const body = {
    model: config.LLM_MODEL,
    messages,
    stream: true,
    max_completion_tokens: Math.max(config.LLM_MAX_TOKENS, MIN_MAX_TOKENS),
    // M3 推理控制：agent 任务不需要深度思考，默认 disabled 节省 token 与延迟
    thinking: { type: config.LLM_THINKING || 'disabled' },
  };
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

  let resp;
  try {
    resp = await axios.post(config.LLM_API_URL, body, {
      timeout: 120000,
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${config.LLM_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      signal,
    });
  } catch (e) {
    console.error('[LLM连接失败]', e.message);
    throw httpError(502, 'AI 服务连接失败，请稍后重试');
  }

  // 非 2xx 时 axios 已抛错（见下方 catch），这里流一定是 200
  return parseOpenAISSE(resp.data);
}

/**
 * 解析 OpenAI 兼容 SSE 流，按 type 产出事件
 * - text: delta.content 文本片段
 * - tool_call: 累积完毕的完整 tool_calls 数组（含 id / name / 解析后的 args）
 * - finish: 终止事件（含 finishReason）
 */
async function* parseOpenAISSE(stream) {
  let buffer = '';
  const decoder = new TextDecoder('utf-8');
  // tool_calls 按 index 累积（流式返回时 args 是分段传来的）
  const toolCallAccum = new Map(); // index -> { id, name, argsRaw }

  for await (const chunk of stream) {
    // TextDecoder(stream:true) 会保留跨 chunk 的不完整多字节序列，下一次迭代再补全
    buffer += decoder.decode(chunk, { stream: true });
    let nlIdx;
    while ((nlIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        yield { type: 'finish', finishReason: 'stop' };
        return;
      }
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { continue; }
      const choice = (evt.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      const finishReason = choice.finish_reason || null;

      // 文本片段
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', delta: delta.content };
      }

      // 工具调用片段（按 index 累积）
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolCallAccum.get(idx) || { id: '', name: '', argsRaw: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') {
            cur.argsRaw += tc.function.arguments;
          }
          toolCallAccum.set(idx, cur);
        }
      }

      // 本帧已结束（finish_reason 非 null）
      if (finishReason) {
        const toolCalls = [];
        for (const [, v] of toolCallAccum) {
          let args = {};
          try {
            args = v.argsRaw ? JSON.parse(v.argsRaw) : {};
          } catch (_) {
            args = { _raw: v.argsRaw, _parseError: true };
          }
          toolCalls.push({ id: v.id, name: v.name, args });
        }
        yield { type: 'tool_call', toolCalls, finishReason };
        return;
      }
    }
  }
  // 流被截断但没收到 finish_reason / [DONE]
  buffer += decoder.decode(); // flush
  yield { type: 'finish', finishReason: 'incomplete' };
}

module.exports = { streamChat };
