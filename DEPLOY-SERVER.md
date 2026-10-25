# 把有间放到服务器上

服务端（聊天、主动联系、微信、记忆）搬到一台常开的 Linux 机器上，Mac 上的桌面角色和网页、微信都作为入口连过去。实测服务常驻内存约 120–260 MB、空闲 CPU 0.3%，模型计算都在 DeepSeek，1 GB 内存的 ARM 盒子足够。

本文只讲在家里局域网内访问。要在外面也能连，需要再加 Tailscale 或 HTTPS，口令在不加密的公网 http 上传输不安全。

## 服务器上（一次性）

1. 安装 Node.js 22.13 以上（arm64 版本），以及生成微信二维码用的 `qrencode`：`sudo apt install qrencode`。不需要 `npm install`。
2. 数据目录如果在 SD 卡上，建议改放 USB 硬盘或 SSD，数据库写入比较频繁。

## 从 Mac 迁移

1. 把代码同步到服务器（按 `.gitignore` 跳过数据、测试副本和生图素材）：
   ```sh
   rsync -a --filter=':- .gitignore' --exclude .git ./ 用户@服务器:~/life/
   ```
2. 停掉 Mac 上的服务，再导出数据。两边同时运行会重复回复微信和发主动消息：
   ```sh
   ./ctl stop
   npm run export:data          # 生成 youjian-data-日期.tar.gz，含数据库、场景图片、.env.local
   scp youjian-data-*.tar.gz 用户@服务器:~/life/
   ```
3. 在服务器上解开，并在 `~/life/.env.local` 末尾加上：
   ```sh
   tar -xzf youjian-data-*.tar.gz -C ~/life
   ```
   ```ini
   LIFE_LISTEN_HOST=0.0.0.0
   LIFE_ALLOWED_HOSTS=192.168.1.20        # 服务器的局域网 IP 或主机名，逗号分隔
   LIFE_ACCESS_TOKEN=用 openssl rand -hex 24 生成的口令
   ```
4. 安装为后台服务（systemd 用户服务，开机自启、崩溃自动重启）：
   ```sh
   cd ~/life && npm run service:install
   ./ctl status
   ```
   如果提示需要 `loginctl enable-linger`，按提示用 sudo 执行一次，否则退出登录后服务会停。
5. Mac 上移除本地服务的自启：`npm run service:remove`（数据保留，随时可以装回来）。

## 各个入口

- **桌面角色**：菜单栏 →「连接服务器…」，填 `http://192.168.1.20:8765/` 和口令，保存后自动重启。地址留空就回到本机服务。
- **浏览器 / 手机**：打开 `http://192.168.1.20:8765/`，第一次输入口令，之后一年内免登录。
- **微信**：不用改，消息由服务器收发。Mac 睡眠也不影响。

## 不随服务器走的部分

- **语音合成**：在 Mac 上的本地模型，盒子跑不动。服务器的 `.env.local` 里设 `LIFE_TTS_BASE_URL=http://Mac的IP:7866`，并让 Mac 上的语音服务监听局域网，朗读才能用；Mac 睡眠时朗读不可用。
- **macOS 系统通知**、**设置页里启动/关闭桌面程序**：只在 Mac 上运行服务时可用，服务器上自动关闭。桌面角色自己的气泡提醒不受影响。

## 访问口令的规则

- 没设 `LIFE_ACCESS_TOKEN` 时行为和以前完全一样，只在本机可访问。
- 设了之后，来自其他机器的请求必须带口令：浏览器通过登录页拿到 cookie（cookie 里是口令的 HMAC，不是口令本身），桌面程序用 `X-Youjian-Token` 头，脚本可用 `Authorization: Bearer 口令`。登录每分钟最多试 6 次。
- 服务器本机发起的请求默认免口令（便于 `./ctl`、评估脚本）。如果在服务前面放了同机反向代理，所有请求都会看起来像本机，需要设 `LIFE_ACCESS_LOCAL=1`。

## 日常维护

- `npm run export:data`：随时备份一份完整数据（服务运行中也能导出一致的快照）。
- `npm run clean:runtime`：评估脚本会往 `.runtime/` 复制整份数据库，定期清理（加 `--apply` 执行）。
