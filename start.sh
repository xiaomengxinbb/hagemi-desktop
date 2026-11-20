#!/bin/sh
# 手动把她叫起来（开机自启走 launchd，平时不需要这个）。
set -eu
APP="/Applications/Hagemi.app"
[ -d "$APP" ] || { echo "还没构建：先跑 ./build-app.sh" >&2; exit 1; }
pkill -f "$APP/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1
# 这台机器的环境里带着 ELECTRON_RUN_AS_NODE=1，不解掉的话 Electron 会当 node 用、窗口根本不开。
env -u ELECTRON_RUN_AS_NODE "$APP/Contents/MacOS/Electron" > /tmp/hagemi-launch.log 2>&1 &
echo "已启动，日志：/tmp/hagemi-launch.log"
