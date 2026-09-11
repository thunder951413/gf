import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Encode the authorization payload locally; never fetch its URL. */
export function encodeWeixinQr(content) {
  if (typeof content !== 'string' || !content || content.length > 4096) throw new Error('微信二维码内容无效');
  const command = ['/opt/homebrew/bin/qrencode', '/usr/local/bin/qrencode'].find(existsSync) || 'qrencode';
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-t', 'PNG', '-o', '-', '-s', '8', '-m', '3'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('二维码生成超时')); }, 10_000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2_000_000) { child.kill(); finish(new Error('二维码生成失败')); } else chunks.push(chunk); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('请安装 qrencode 后再生成微信二维码')));
    child.on('close', code => finish(code === 0 && size ? null : new Error('二维码生成失败'), Buffer.concat(chunks)));
    child.stdin.end(content);
  });
}
