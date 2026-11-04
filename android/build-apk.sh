#!/usr/bin/env bash
# 手工打包（不依赖 Gradle / AGP，只用 Android SDK 的 build-tools）：
#   ./build-apk.sh
# 产物：build/manual/BotCamp-<version>.apk（用 botcamp-android.keystore 签名）
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
PLATFORM="$SDK/platforms/android-34/android.jar"
APP=app/src/main
PKG=site.demox.botcamp
VERSION_CODE=2050
VERSION_NAME=2.1.0
OUT="$ROOT/build/manual"

[ -x "$BT/aapt2" ] || { echo "找不到 build-tools（$SDK/build-tools）"; exit 1; }
[ -f "$PLATFORM" ] || { echo "找不到 android-34 平台（$PLATFORM）"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

# 清单里不写 package（AGP 8 不允许），这里注入一份给 aapt2 用
sed "s|<manifest |<manifest package=\"$PKG\" |" "$APP/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"

echo "==> aapt2 compile"
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/res/resources.zip"

echo "==> aapt2 link"
"$BT/aapt2" link \
  -o "$OUT/unsigned.apk" \
  -I "$PLATFORM" \
  --manifest "$OUT/AndroidManifest.xml" \
  -R "$OUT/res/resources.zip" \
  --java "$OUT/gen" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --auto-add-overlay

echo "==> javac"
find "$APP/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# JDK 17 只允许 source/target 8 时用 bootclasspath 指向 android.jar
javac -encoding UTF-8 -source 8 -target 8 -Xlint:-options \
  -bootclasspath "$PLATFORM" -classpath "$PLATFORM" \
  -d "$OUT/classes" @"$OUT/sources.txt"

echo "==> d8"
"$BT/d8" --lib "$PLATFORM" --min-api 26 --release \
  --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

echo "==> package"
(cd "$OUT/dex" && zip -q -X "$OUT/unsigned.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "==> sign"
PASS="$(awk -F= '/^storePassword=/{print $2}' keystore.properties)"
ALIAS="$(awk -F= '/^keyAlias=/{print $2}' keystore.properties)"
"$BT/apksigner" sign \
  --ks botcamp-android.keystore --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --out "$OUT/BotCamp-$VERSION_NAME.apk" "$OUT/aligned.apk"

"$BT/apksigner" verify --print-certs "$OUT/BotCamp-$VERSION_NAME.apk" | head -3
echo "==> OK: $OUT/BotCamp-$VERSION_NAME.apk"
