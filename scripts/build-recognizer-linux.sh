#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${PROJECTX_NATIVE_BUILD_DIR:-$ROOT_DIR/ignored/native-linux-x64}"
STAGE="$ROOT_DIR/resources/native/correction-linux-x64"
TOOLCHAIN=()
if [ "$(uname -m)" != x86_64 ]; then
  TOOLCHAIN=(-DCMAKE_TOOLCHAIN_FILE="$ROOT_DIR/native/cmake/linux-x64.cmake")
fi
mkdir -p "$BUILD_ROOT/deps/include/nlohmann" "$STAGE/licenses"
download() {
  local url="$1" file="$2" digest="$3"
  if [ ! -f "$file" ]; then curl -fsSL --retry 3 "$url" -o "$file"; fi
  echo "$digest  $file" | sha256sum -c -
}
download https://github.com/opencv/opencv/archive/refs/tags/4.13.0.tar.gz "$BUILD_ROOT/opencv.tar.gz" 1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d
download https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp "$BUILD_ROOT/deps/include/nlohmann/json.hpp" aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63
if [ ! -d "$BUILD_ROOT/deps/opencv-4.13.0" ]; then tar -xzf "$BUILD_ROOT/opencv.tar.gz" -C "$BUILD_ROOT/deps"; fi
cmake -S "$BUILD_ROOT/deps/opencv-4.13.0" -B "$BUILD_ROOT/opencv-build" "${TOOLCHAIN[@]}" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$BUILD_ROOT/opencv-install" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_LIST=core,imgproc,imgcodecs,objdetect \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_opencv_apps=OFF \
  -DBUILD_JAVA=OFF -DBUILD_opencv_python2=OFF -DBUILD_opencv_python3=OFF \
  -DWITH_IPP=OFF -DWITH_OPENCL=OFF -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_GTK=OFF \
  -DWITH_LAPACK=OFF -DWITH_EIGEN=OFF -DWITH_ITT=OFF -DWITH_ADE=OFF -DWITH_TBB=OFF \
  -DWITH_PROTOBUF=OFF -DBUILD_PROTOBUF=OFF -DWITH_QUIRC=ON \
  -DWITH_OPENEXR=OFF -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF \
  -DBUILD_ZLIB=ON -DBUILD_JPEG=ON -DBUILD_PNG=ON -DBUILD_TIFF=ON -DBUILD_WEBP=ON \
  -DCPU_BASELINE=SSE2 -DCPU_DISPATCH=
cmake --build "$BUILD_ROOT/opencv-build" --parallel "${NATIVE_BUILD_JOBS:-4}"
cmake --install "$BUILD_ROOT/opencv-build"
cmake -S "$ROOT_DIR/native" -B "$BUILD_ROOT/app-build" "${TOOLCHAIN[@]}" \
  -DCMAKE_BUILD_TYPE=Release -DOpenCV_DIR="$BUILD_ROOT/opencv-install/lib/cmake/opencv4" \
  -DNLOHMANN_JSON_INCLUDE_DIR="$BUILD_ROOT/deps/include" -DCMAKE_INSTALL_PREFIX="$STAGE"
cmake --build "$BUILD_ROOT/app-build" --parallel "${NATIVE_BUILD_JOBS:-4}"
cmake --install "$BUILD_ROOT/app-build"
if [ "$(uname -m)" = x86_64 ]; then strip "$STAGE/answer-card-recognizer"; else x86_64-linux-gnu-strip "$STAGE/answer-card-recognizer"; fi
cp "$BUILD_ROOT/deps/opencv-4.13.0/LICENSE" "$STAGE/licenses/OpenCV-LICENSE.txt"
download https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT "$BUILD_ROOT/nlohmann-LICENSE.MIT" 46a65cffd1ea955132d95a8dd921640714a8d6b537d2e4e482d31145ae95b603
cp "$BUILD_ROOT/nlohmann-LICENSE.MIT" "$STAGE/licenses/nlohmann-LICENSE.MIT"
cp -R "$BUILD_ROOT/opencv-install/share/licenses/opencv4" "$STAGE/licenses/"
cp "$BUILD_ROOT/deps/opencv-4.13.0/3rdparty/libwebp/COPYING" "$STAGE/licenses/libwebp-COPYING.txt"
cp "$BUILD_ROOT/deps/opencv-4.13.0/3rdparty/quirc/LICENSE" "$STAGE/licenses/quirc-LICENSE.txt"
# libstdc++ and libgcc are statically linked under the GCC Runtime Library Exception.
if [ "$(uname -m)" = x86_64 ]; then CXX_BIN=g++; else CXX_BIN=x86_64-linux-gnu-g++; fi
GCC_MAJOR="$($CXX_BIN -dumpversion | cut -d. -f1)"
cp "/usr/share/doc/gcc-$GCC_MAJOR-base/copyright" "$STAGE/licenses/GCC-runtime-copyright.txt"
cp /usr/share/common-licenses/GPL-3 "$STAGE/licenses/GPL-3.txt"
(cd "$ROOT_DIR" && sha256sum native/CMakeLists.txt native/cmake/linux-x64.cmake native/AnswerCardRecognizer/answer-card-recognizer/*.cpp native/AnswerCardRecognizer/answer-card-recognizer/*.hpp) > "$STAGE/source-sha256.txt"
file "$STAGE/answer-card-recognizer"
sha256sum "$STAGE/answer-card-recognizer"
