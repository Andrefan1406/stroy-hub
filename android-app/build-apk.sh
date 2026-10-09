#!/usr/bin/env bash
# Сборка подписанного .apk без Gradle — напрямую инструментами Android SDK
# (aapt2 → javac → d8 → zipalign → apksigner), которые Gradle и так вызывает
# внутри. Нужна, потому что Gradle и его Android-плагин — сотни мегабайт
# зависимостей; здесь хватает JDK 17 и Android SDK (platform 34, build-tools
# 34.0.0). Проект при этом остаётся обычным Gradle-проектом: в Android
# Studio его можно открыть и собрать как обычно.
#
# Запуск (Git Bash): ./build-apk.sh [адрес страницы]
#   JAVA_HOME, ANDROID_HOME — если не заданы, берутся из %LOCALAPPDATA%\android-build.
#   Ключ подписи — %USERPROFILE%\.stroy-hub-android\keystore.properties (вне репозитория).
# Версия (versionCode/versionName) и адрес по умолчанию читаются из app/build.gradle.
set -euo pipefail

cd "$(dirname "$0")"
TOOLS_DIR="${LOCALAPPDATA:-}/android-build"
JAVA_HOME="${JAVA_HOME:-$(ls -d "$TOOLS_DIR"/jdk-17* 2>/dev/null | head -1)}"
ANDROID_HOME="${ANDROID_HOME:-$TOOLS_DIR/sdk}"
BUILD_TOOLS="$ANDROID_HOME/build-tools/34.0.0"
ANDROID_JAR="$ANDROID_HOME/platforms/android-34/android.jar"
KEYSTORE_PROPS="${KEYSTORE_PROPS:-$HOME/.stroy-hub-android/keystore.properties}"
for f in "$JAVA_HOME/bin/javac" "$BUILD_TOOLS/aapt2" "$ANDROID_JAR" "$KEYSTORE_PROPS"; do
  [ -e "$f" ] || [ -e "$f.exe" ] || { echo "Не найдено: $f" >&2; exit 1; }
done

# d8/apksigner (.bat) ищут java по JAVA_HOME/PATH.
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

PACKAGE=kz.vkdev.transport
GRADLE=app/build.gradle
VERSION_CODE=$(sed -n "s/^ *versionCode \([0-9]*\).*/\1/p" "$GRADLE")
VERSION_NAME=$(sed -n "s/^ *versionName '\([^']*\)'.*/\1/p" "$GRADLE")
DEFAULT_URL=$(sed -n "s/.*?: '\(https:[^']*\)'.*/\1/p" "$GRADLE")
START_URL="${1:-$DEFAULT_URL}"
# На Windows d8 и apksigner — .bat-файлы.
tool() { [ -e "$BUILD_TOOLS/$1.bat" ] && echo "$BUILD_TOOLS/$1.bat" || echo "$BUILD_TOOLS/$1"; }
D8=$(tool d8)
APKSIGNER=$(tool apksigner)
prop() { sed -n "s/^$1=//p" "$KEYSTORE_PROPS" | tr -d '\r'; }

OUT=build/apk
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"
SRC=app/src/main

echo "1/6 ресурсы"
"$BUILD_TOOLS/aapt2" compile --dir "$SRC/res" -o "$OUT/res.zip"
# В манифесте нет package (в Gradle он задаётся namespace) — добавляем.
sed "s|<manifest |<manifest package=\"$PACKAGE\" |" "$SRC/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
"$BUILD_TOOLS/aapt2" link -o "$OUT/unsigned.apk" -I "$ANDROID_JAR" --manifest "$OUT/AndroidManifest.xml" \
  --java "$OUT/gen" --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" "$OUT/res.zip"

echo "2/6 BuildConfig (START_URL=$START_URL)"
mkdir -p "$OUT/gen/kz/vkdev/transport"
cat > "$OUT/gen/kz/vkdev/transport/BuildConfig.java" <<EOF
package $PACKAGE;
public final class BuildConfig {
  public static final String START_URL = "$START_URL";
}
EOF

echo "3/6 javac"
find "$SRC/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
"$JAVA_HOME/bin/javac" -source 11 -target 11 -encoding UTF-8 -Xlint:-options \
  -classpath "$ANDROID_JAR" -d "$OUT/classes" @"$OUT/sources.txt"

echo "4/6 d8"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$D8" --release --min-api 24 --lib "$ANDROID_JAR" --output "$OUT/dex" @"$OUT/classes.txt"
(cd "$OUT/dex" && "$JAVA_HOME/bin/jar" -uf ../unsigned.apk classes.dex)

echo "5/6 zipalign"
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "6/6 подпись"
APK="$OUT/vkdev-transport-$VERSION_NAME.apk"
"$APKSIGNER" sign --ks "$(prop storeFile)" --ks-key-alias "$(prop keyAlias)" \
  --ks-pass "pass:$(prop storePassword)" --key-pass "pass:$(prop keyPassword)" --out "$APK" "$OUT/aligned.apk"
"$APKSIGNER" verify "$APK"
echo "Готово: $APK"
