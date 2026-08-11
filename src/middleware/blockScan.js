// 恶意扫描路径拦截（对齐 MIGRATION_DESIGN §9.1）
const MALICIOUS_PATTERNS = [
  '/etc/passwd', '/proc/self', '/.env', '/.git',
  '/wp-admin', '/wp-login', '/xmlrpc.php', '/actuator',
  '/shell', '/webshell', '@fs',
];

function blockScan(req, res, next) {
  const raw = req.path;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const combined = (raw + ' ' + decoded).toLowerCase();
  if (MALICIOUS_PATTERNS.some((p) => combined.includes(p.toLowerCase()))) {
    return res.status(403).json({ detail: 'Forbidden' });
  }
  next();
}

module.exports = blockScan;
module.exports.MALICIOUS_PATTERNS = MALICIOUS_PATTERNS;
