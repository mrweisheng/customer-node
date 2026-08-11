// 验证 bcryptjs 能否正确验证迁移过来的 hash（独立测试，不依赖服务）
const bcrypt = require('bcryptjs');

const hash = '$2b$12$1YOJf93g4ojFtM1Hs1.VRucxBnrsEl2OHVHzo9ERrGBBygWp90lrS';

// 你在登录框输入的密码会作为命令行参数传入
const pwd = process.argv[2];
if (!pwd) {
  console.log('用法: node scripts/verify-bcrypt.js <你的密码>');
  console.log('（这个脚本不会保存密码，只用于本地验证）');
  process.exit(0);
}

console.log('hash 前缀:', hash.slice(0, 7));
console.log('hash 长度:', hash.length);
console.log('rounds:', parseInt(hash.split('$')[2], 10));

const ok = bcrypt.compareSync(pwd, hash);
console.log('验证结果:', ok ? '✓ 通过' : '✗ 不匹配');
