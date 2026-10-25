#!/bin/zsh
# 用真实模型在隔离副本里测试「每日小事 / 心情 / 回头问」：生成当天小事，再模拟 6 轮聊天和 2 次主动联系。
# 不发微信、不写正式聊天记录。结果写到 .runtime/daily-happenings/live-<时间>/，并在这个窗口打印摘要。
cd "$(dirname "$0")"
S=$(date +%m%d%H%M); L=live-$S
echo "正在用真实模型测试（约 2–4 分钟）…"
node scripts/evaluate-daily-happenings.mjs --live --label "$L" 2>&1 | tee ".runtime/daily-happenings/log-$L.txt"
echo
echo "完成。报告目录：.runtime/daily-happenings/$L/"
echo "可以关闭这个窗口了。"
