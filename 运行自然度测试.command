#!/bin/zsh
# 自然度与调参实测（第二轮）：在隔离的数据副本里运行，不写入日常聊天、不发微信。约 5 分钟。
cd "$(dirname "$0")"
R=.runtime/naturalness
T="$PWD/$R/template-v2"
S=$(date +%m%d%H%M)
echo "并行运行 5 组…"
node scripts/evaluate-naturalness.mjs --label after-$S --live --template "$T" > $R/log-after-$S.txt 2>&1 &
node scripts/evaluate-naturalness.mjs --label v15-$S --live --template "$T" --tuning '{"verbosity":15}' > $R/log-v15-$S.txt 2>&1 &
node scripts/evaluate-naturalness.mjs --label v85-$S --live --template "$T" --tuning '{"verbosity":85}' > $R/log-v85-$S.txt 2>&1 &
node scripts/evaluate-naturalness.mjs --label calm-$S --live --template "$T" --tuning '{"playfulness":10,"coyness":10,"flirtation":10,"warmth":25,"pleasing":15,"verbosity":40}' > $R/log-calm-$S.txt 2>&1 &
node scripts/evaluate-naturalness.mjs --label lively-$S --live --template "$T" --tuning '{"playfulness":95,"coyness":95,"flirtation":90,"warmth":90,"pleasing":85,"verbosity":40}' > $R/log-lively-$S.txt 2>&1 &
wait
echo "完成：$S" > $R/DONE2-$S
echo "全部完成，可以关闭这个窗口了。"
