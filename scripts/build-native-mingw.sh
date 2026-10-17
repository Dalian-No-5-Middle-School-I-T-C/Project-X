#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:-ia32}"
case "$ARCH" in
  ia32) BUILD_ROOT="$ROOT_DIR/ignored/native-mingw"; TOOL_PREFIX=i686-w64-mingw32; PE_FORMAT=pei-i386; QR_SYMBOL=_quirc_decode ;;
  x64) BUILD_ROOT="$ROOT_DIR/ignored/native-mingw-x64"; TOOL_PREFIX=x86_64-w64-mingw32; PE_FORMAT=pei-x86-64; QR_SYMBOL=quirc_decode ;;
  *) echo "Usage: $0 [ia32|x64]" >&2; exit 1 ;;
esac
DEPS_DIR="$BUILD_ROOT/deps"
TOOLCHAIN="$ROOT_DIR/native/cmake/mingw-$ARCH.cmake"
OPENCV_INSTALL="$BUILD_ROOT/opencv-install"
STAGE_DIR="$BUILD_ROOT/stage/win-$ARCH"

for tool in cmake curl tar rg "$TOOL_PREFIX-g++" "$TOOL_PREFIX-objdump" "$TOOL_PREFIX-strip"; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
mkdir -p "$BUILD_ROOT/downloads" "$DEPS_DIR/include/nlohmann" "$STAGE_DIR"

download_verified() {
  local url="$1" destination="$2" expected="$3" actual
  if [ ! -f "$destination" ]; then
    curl -fsSL --retry 3 "$url" -o "$destination.part"
    actual="$(cmake -E sha256sum "$destination.part")"
    [ "${actual%% *}" = "$expected" ] || { echo "Download checksum mismatch: $url" >&2; exit 1; }
    mv "$destination.part" "$destination"
  fi
  actual="$(cmake -E sha256sum "$destination")"
  [ "${actual%% *}" = "$expected" ] || { echo "Cached dependency checksum mismatch: $destination" >&2; exit 1; }
}

download_verified \
  https://github.com/opencv/opencv/archive/refs/tags/4.13.0.tar.gz \
  "$BUILD_ROOT/downloads/opencv-4.13.0.tar.gz" \
  1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d
download_verified \
  https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp \
  "$DEPS_DIR/include/nlohmann/json.hpp" \
  aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63
download_verified \
  https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT \
  "$DEPS_DIR/nlohmann-LICENSE.MIT" \
  46a65cffd1ea955132d95a8dd921640714a8d6b537d2e4e482d31145ae95b603
if [ ! -f "$DEPS_DIR/opencv-4.13.0/CMakeLists.txt" ]; then
  tar -xzf "$BUILD_ROOT/downloads/opencv-4.13.0.tar.gz" -C "$DEPS_DIR"
fi

cmake -S "$DEPS_DIR/opencv-4.13.0" -B "$BUILD_ROOT/opencv-build" \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$OPENCV_INSTALL" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_LIST=core,imgproc,imgcodecs,objdetect \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_opencv_apps=OFF \
  -DBUILD_JAVA=OFF -DBUILD_opencv_python2=OFF -DBUILD_opencv_python3=OFF \
  -DWITH_IPP=OFF -DWITH_OPENCL=OFF -DWITH_FFMPEG=OFF -DWITH_DSHOW=OFF -DWITH_MSMF=OFF \
  -DWITH_DIRECTX=OFF -DWITH_LAPACK=OFF -DWITH_EIGEN=OFF -DWITH_ITT=OFF -DWITH_ADE=OFF \
  -DWITH_PROTOBUF=OFF -DBUILD_PROTOBUF=OFF \
  -DWITH_QUIRC=ON \
  -DWITH_OPENEXR=OFF -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF \
  -DBUILD_ZLIB=ON -DBUILD_JPEG=ON -DBUILD_PNG=ON -DBUILD_TIFF=ON -DBUILD_WEBP=ON \
  -DCPU_BASELINE=SSE2 -DCPU_DISPATCH=
rg -q '^#define HAVE_QUIRC' "$BUILD_ROOT/opencv-build/opencv2/cvconfig.h" || {
  echo "OpenCV must include the QR decoder used by card identity checks" >&2; exit 1;
}
cmake --build "$BUILD_ROOT/opencv-build" --parallel "${NATIVE_BUILD_JOBS:-8}"
cmake --install "$BUILD_ROOT/opencv-build"

cmake -S "$ROOT_DIR/native" -B "$BUILD_ROOT/app-build" \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" -DCMAKE_BUILD_TYPE=Release \
  -DOpenCV_DIR="$OPENCV_INSTALL/lib/cmake/opencv4" -DNLOHMANN_JSON_INCLUDE_DIR="$DEPS_DIR/include" \
  -DCMAKE_INSTALL_PREFIX="$STAGE_DIR"
cmake --build "$BUILD_ROOT/app-build" --parallel "${NATIVE_BUILD_JOBS:-8}"
cmake --install "$BUILD_ROOT/app-build"
cp "$ROOT_DIR/native/ScannerBridge/third_party/twain-dsm-2.5.1/dsm/win-$ARCH/TWAINDSM.dll" "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/licenses"
cp "$DEPS_DIR/opencv-4.13.0/LICENSE" "$STAGE_DIR/licenses/OpenCV-LICENSE.txt"
cp "$DEPS_DIR/nlohmann-LICENSE.MIT" "$STAGE_DIR/licenses/nlohmann-LICENSE.MIT"
cp "$ROOT_DIR/native/licenses/"*.txt "$STAGE_DIR/licenses/"
cp "$ROOT_DIR/resources/native/correction-linux-x64/licenses/GPL-3.txt" "$STAGE_DIR/licenses/"
cp "$ROOT_DIR/native/ScannerBridge/third_party/THIRD_PARTY_NOTICES.md" "$STAGE_DIR/licenses/TWAIN-NOTICES.md"
cp -R "$OPENCV_INSTALL/share/licenses/opencv4" "$STAGE_DIR/licenses/"
cp "$DEPS_DIR/opencv-4.13.0/3rdparty/libwebp/COPYING" "$STAGE_DIR/licenses/libwebp-COPYING.txt"
cp "$DEPS_DIR/opencv-4.13.0/3rdparty/quirc/LICENSE" "$STAGE_DIR/licenses/quirc-LICENSE.txt"
for binary in "$STAGE_DIR"/*.exe "$STAGE_DIR"/*.dll; do
  "$TOOL_PREFIX-objdump" -f "$binary" | rg -q "file format $PE_FORMAT" || {
    echo "Not a Windows $ARCH binary: $binary" >&2; exit 1;
  }
done
"$TOOL_PREFIX-objdump" -t "$STAGE_DIR/answer-card-recognizer.exe" | rg "${QR_SYMBOL}\$" >/dev/null || {
  echo "Recognizer must link the QR decoder used by card identity checks" >&2; exit 1;
}
"$TOOL_PREFIX-strip" "$STAGE_DIR/answer-card-recognizer.exe"
(cd "$ROOT_DIR" && cmake -E sha256sum native/CMakeLists.txt "native/cmake/mingw-$ARCH.cmake" scripts/build-native-mingw.sh \
  native/AnswerCardRecognizer/answer-card-recognizer/*.cpp native/AnswerCardRecognizer/answer-card-recognizer/*.hpp) > "$STAGE_DIR/source-sha256.txt"
echo "Windows $ARCH native components: $STAGE_DIR"
