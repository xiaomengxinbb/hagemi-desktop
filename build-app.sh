#!/bin/sh
# 把宿主装成一个真正的 macOS 应用：/Applications/Hagemi.app。
# 不联网、不装依赖：直接复用 DSH 自带的 Electron 运行时，只加一个 Resources/app。
set -eu

APP="/Applications/Hagemi.app"
SRC="${1:-$(cd "$(dirname "$0")" && pwd)}"
ELECTRON="${ELECTRON_APP:-$HOME/.dsh/electron/Electron.app}"
PLUGIN_DIR="${HAGEMI_PLUGIN_DIR:-$HOME/.gemini/config/plugins/hagemi-pet-agy}"
BUNDLE_ID="com.hagemi.desktop"

[ -d "$ELECTRON" ] || { echo "找不到 Electron 运行时：$ELECTRON" >&2; exit 1; }
[ -f "$SRC/main.cjs" ] || { echo "找不到 main.cjs：$SRC" >&2; exit 1; }

# 旧版本还在跑的话先请它退场，否则覆盖时会被占用。
pkill -f "$APP/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1
rm -rf "$APP"
cp -R "$ELECTRON" "$APP"

setPlist() {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$APP/Contents/Info.plist" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$APP/Contents/Info.plist" 2>/dev/null || true
}

setPlist CFBundleName Hagemi
setPlist CFBundleDisplayName Hagemi
setPlist CFBundleIdentifier "$BUNDLE_ID"
setPlist CFBundleShortVersionString 1.0.0
setPlist CFBundleVersion 1.0.0
setPlist CFBundleExecutable Electron
setPlist CFBundleIconFile icon.icns
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$APP/Contents/Info.plist" 2>/dev/null || true
# 不删掉的话，Electron 会校验 Resources/default_app.asar，我们自己的 Resources/app 会被拒。
/usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$APP/Contents/Info.plist" 2>/dev/null || true

mkdir -p "$APP/Contents/Resources/app"
for file in main.cjs preload.cjs package.json; do
  cp "$SRC/$file" "$APP/Contents/Resources/app/$file"
done

# 图标现场从插件的 logo 生成：仓库里不放美术文件，省的厂商文件还要跟着一起分发。
# 想换图标就设 ICON_PATH 指一个现成的 .icns。
ICON="${ICON_PATH:-}"
if [ -z "$ICON" ] && [ -f "$PLUGIN_DIR/assets/logo.png" ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  ICONSET="$WORK/Hagemi.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$PLUGIN_DIR/assets/logo.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1
    double=$((size * 2))
    sips -z $double $double "$PLUGIN_DIR/assets/logo.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$WORK/icon.icns" >/dev/null 2>&1 || true
  ICON="$WORK/icon.icns"
fi
[ -n "$ICON" ] && [ -f "$ICON" ] && cp "$ICON" "$APP/Contents/Resources/icon.icns"

# ad-hoc 签名：本机自用够了，不用开发者证书。
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "（ad-hoc 签名失败，不影响运行）" >&2
echo "已安装：$APP"
