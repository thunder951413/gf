#!/bin/zsh
# 1) 用真实模型在隔离副本里最后验证一次（约 3 分钟）；2) 通过才重启服务；3) 调整相处参数。
cd "$(dirname "$0")"
R=.runtime/naturalness; T="$PWD/$R/template-v2"; S=$(date +%m%d%H%M)
echo "1/3 最后验证（约 3 分钟）…"
node scripts/evaluate-naturalness.mjs --label final-$S --live --template "$T" > $R/log-final-$S.txt 2>&1
if ! node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const failed=r.transcript.filter(t=>t.error&&t.type==="chat");
console.log(`验证：${r.turns} 轮，失败 ${failed.length} 轮，缓存命中 ${Math.round(r.cachedTokens/r.promptTokens*100)}%`);
process.exit(failed.length?1:0);' "$R/final-$S/report.json"; then
  echo "验证没有通过，服务保持原样，没有重启。请把这个窗口的内容告诉 Claude。"; exit 1
fi
echo "2/3 重启有间服务…"
./ctl restart || { echo "重启失败，请把这个窗口的内容告诉 Claude。"; exit 1; }
echo "3/3 调整相处参数（话量 50、讨好 60、敏感 60，其余保持）…"
node -e '
const base="http://127.0.0.1:8765";
(async()=>{
  const cur=await (await fetch(base+"/api/companion-tuning")).json();
  const values={...cur.values,verbosity:50,pleasing:60,sensitivity:60};
  const r=await fetch(base+"/api/companion-tuning",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({values,revision:cur.revision})});
  console.log(r.ok?"参数已保存："+JSON.stringify(values):"参数保存失败："+await r.text());
})().catch(e=>console.log("参数保存失败："+e.message));'
echo "完成：$S" > $R/APPLIED-$S
echo "全部完成。新版已生效，可以关闭这个窗口去聊天了。"
