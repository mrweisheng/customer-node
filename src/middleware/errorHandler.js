// 统一错误处理器 + httpError 辅助（对齐 MIGRATION_DESIGN §8 错误格式 {detail}）
// 用法：throw httpError(401, '账号或密码错误');

function httpError(status, detail) {
  const err = new Error(detail);
  err.status = status;
  err.detail = detail;
  return err;
}

// Express 错误处理中间件（4 参数，必须放最后）
function errorHandler(err, req, res, next) {
  // SSE 流已开始的错误由路由内部处理，这里跳过已发响应
  if (res.headersSent) return next(err);

  // Express body-parser 非法 JSON：err.status=400 且带 type='entity.parse.failed'
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ detail: '请求体不是合法的 JSON' });
  }

  const status = err.status || 500;
  const detail = err.detail || err.message || 'Internal Server Error';

  // 4xx 业务错误用 err.detail；500 不外泄堆栈
  if (status >= 500) {
    console.error('[ERROR]', err);
  }
  res.status(status).json({ detail });
}

module.exports = { httpError, errorHandler };
