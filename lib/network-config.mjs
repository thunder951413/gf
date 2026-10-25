import { isIP } from 'node:net';

export function networkConfig(options = {}, env = process.env) {
  const listenHost = options.listenHost ?? env.LIFE_LISTEN_HOST ?? '127.0.0.1';
  if (isIP(listenHost) !== 4) throw new Error('LIFE_LISTEN_HOST 需要填写 IPv4 地址');
  const input = options.allowedHosts ?? env.LIFE_ALLOWED_HOSTS ?? '';
  const extra = (Array.isArray(input) ? input : String(input).split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  // IPv4 addresses or host names (a LAN name, a Tailscale MagicDNS name, a domain).
  const hostname = x => /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(x) && !/^[0-9.]+$/u.test(x);
  if (extra.some(x => x === '0.0.0.0' || (isIP(x) !== 4 && !hostname(x)))) throw new Error('LIFE_ALLOWED_HOSTS 需要填写逗号分隔的访问 IP 地址或主机名');
  const allowedHosts = new Set(['127.0.0.1', 'localhost', ...extra]);
  if (listenHost !== '0.0.0.0') allowedHosts.add(listenHost);
  return { listenHost, allowedHosts };
}
