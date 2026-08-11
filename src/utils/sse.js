// SSE 数据帧构造（对齐 MIGRATION_DESIGN §6.4）
// 帧格式：data: <json>\n\n（两个换行结尾，不用 event: 字段）

function sse(data) {
  // JSON.stringify 默认保留 UTF-8 原字符，与 Python json.dumps(ensure_ascii=False) 一致
  return `data: ${JSON.stringify(data)}\n\n`;
}

module.exports = { sse };
