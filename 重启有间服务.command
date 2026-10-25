#!/bin/zsh
# 重启有间本地服务，让代码改动生效。聊天记录和设置不受影响。
cd "$(dirname "$0")"
./ctl restart && echo "已重启，可以关闭这个窗口了。"
