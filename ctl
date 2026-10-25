#!/usr/bin/env bash
# Control the locally installed 有间 companion service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="local.youjian.companion"
DOMAIN="gui/$(id -u)"
TARGET="${DOMAIN}/${LABEL}"
URL="http://127.0.0.1:8765/"

usage() {
  cat <<'EOF'
用法：./ctl start|stop|restart|status

仅控制有间本地服务；TTS 由其独立程序管理。
EOF
}

loaded() {
  launchctl print "$TARGET" >/dev/null 2>&1
}

ready() {
  curl --silent --show-error --fail --max-time 2 "$URL" >/dev/null 2>&1
}

wait_for() {
  local expected="$1" verb
  for _ in {1..30}; do
    if ready; then
      [[ "$expected" == "up" ]] && return 0
    elif [[ "$expected" == "down" ]]; then
      return 0
    fi
    sleep 1
  done
  verb="启动"
  [[ "$expected" == "down" ]] && verb="停止"
  echo "有间服务在等待后仍未${verb}。" >&2
  return 1
}

start() {
  # bootout can briefly leave a visible job that kickstart can no longer find.
  if ! loaded || ! launchctl kickstart -k "$TARGET"; then
    node "$ROOT/scripts/service.mjs" install
  fi
  wait_for up
  echo "有间服务已启动：$URL"
}

stop() {
  if loaded; then
    # Disable before bootout so KeepAlive does not immediately relaunch it.
    launchctl disable "$TARGET" || true
    launchctl bootout "$TARGET"
  fi
  wait_for down
  for _ in {1..30}; do
    if ! loaded; then break; fi
    sleep 0.1
  done
  echo "有间服务已停止。"
}

status() {
  if loaded; then
    if ready; then
      echo "有间服务：运行中（${URL}）"
    else
      echo "有间服务：已加载，接口尚未就绪"
    fi
    launchctl print "$TARGET" | awk '/^[[:space:]]*(state|pid|last exit code) =/ {print}'
  else
    echo "有间服务：未运行"
  fi
}

if [[ "$(uname -s)" == "Linux" ]]; then
  # systemd user unit installed by `npm run service:install`.
  UNIT="youjian.service"
  case "${1:-}" in
    start) systemctl --user start "$UNIT"; wait_for up; echo "有间服务已启动：$URL" ;;
    stop) systemctl --user stop "$UNIT"; wait_for down; echo "有间服务已停止。" ;;
    restart) systemctl --user restart "$UNIT"; wait_for up; echo "有间服务已重启：$URL" ;;
    status) systemctl --user --no-pager status "$UNIT" | head -5 ;;
    *) usage; exit 2 ;;
  esac
  exit 0
fi

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) usage; exit 2 ;;
esac
