#!/usr/bin/env bash
# Recipes and EXIT traps invoke these functions indirectly.
# shellcheck disable=SC2329
set -euo pipefail
script="$(realpath "${BASH_SOURCE[0]}")"
# shellcheck source=./jobs.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/jobs.sh"
cmake_cache=()
# Existing build trees keep their generator for incremental rebuilds.
codec_ninja_jobserver() {
  local version major minor
  command -v ninja >/dev/null || return 1
  version=$(ninja --version)
  IFS=. read -r major minor _ <<< "$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  ((major > 1 || (major == 1 && minor >= 13))) && [[ "${MAKEFLAGS:-}" == *--jobserver-auth=fifo:* ]]
}
codec_cmake() {
  local generator=()
  if [[ ! -f build/CMakeCache.txt ]]; then
    generator=(-G 'Unix Makefiles')
    if codec_ninja_jobserver; then generator=(-G Ninja); fi
  fi
  cmake "${generator[@]}" "$@"
}
codec_cmake_build() {
  local parallel=()
  # Old cached Ninja trees cannot join the pool; use only this recipe's token.
  if [[ -f build/build.ninja ]] && ! codec_ninja_jobserver; then parallel=(-j1); fi
  cmake --build build "${parallel[@]}"
}
autotools_cc="${CC:-cc}" autotools_cxx="${CXX:-c++}"
if command -v ccache >/dev/null; then
  cmake_cache=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
  autotools_cc="ccache $autotools_cc" autotools_cxx="ccache $autotools_cxx"
fi
cd "${OPENFRAME_CODECS:-$HOME/openframe-native-validation-20261026/codec-build}"
root=$PWD
if [[ "${1:-}" != --library && "${1:-}" != --execute ]]; then
  exec 9>"$root/build.lock"
  flock -n 9 || { echo 'Another native codec operation is running' >&2; exit 1; }
fi
export LD_LIBRARY_PATH="$root/prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PKG_CONFIG_PATH="$root/prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export CMAKE_PREFIX_PATH="$root/prefix${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
export CPPFLAGS="-I$root/prefix/include"
export LDFLAGS="-L$root/prefix/lib -Wl,-rpath,$root/prefix/lib"
if [[ ! -f "$root/system-libs" ]]; then
  export PATH="$root/sysroot/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:$root/sysroot/usr/lib/x86_64-linux-gnu"
  export PKG_CONFIG_PATH="$PKG_CONFIG_PATH:$root/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$root/sysroot/usr/share/pkgconfig"
  export ACLOCAL_PATH="$root/sysroot/usr/share/aclocal"
  export PYTHONPATH="$root/sysroot/usr/lib/python3/dist-packages"
  export CMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH:$root/sysroot/usr"
  export CPPFLAGS="$CPPFLAGS -I$root/sysroot/usr/include"
  export LDFLAGS="$LDFLAGS -L$root/sysroot/usr/lib/x86_64-linux-gnu"
  ln -sf pkgconf sysroot/usr/bin/pkg-config
fi
# Keep the pinned Highway headers ahead of the older bootstrap package headers.
if [[ "${1:-}" != --library && "${1:-}" != --execute ]]; then
  rm -rf -- "$root/sysroot/usr/include/hwy"
fi

build_highway() (
cd "$root/sources/highway-system"
codec_cmake "${cmake_cache[@]}" -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$root/prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_SHARED_LIBS=ON \
  -DHWY_ENABLE_TESTS=OFF \
  -DHWY_ENABLE_EXAMPLES=OFF \
  -DHWY_ENABLE_CONTRIB=OFF
codec_cmake_build
cmake --install build
)

build_jpegli() (
cd "$root/sources/jpegli"
for patchfile in "$root"/jpegli-patches/*.patch; do
 if git apply --check "$patchfile"; then git apply "$patchfile"; else git apply --reverse --check "$patchfile"; fi
done
codec_cmake "${cmake_cache[@]}" -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$root/prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_TESTING=OFF \
  -DJPEGLI_ENABLE_DOXYGEN=OFF \
  -DJPEGLI_ENABLE_MANPAGES=OFF \
  -DJPEGLI_ENABLE_BENCHMARK=OFF \
  -DJPEGLI_ENABLE_TOOLS=OFF \
  -DJPEGLI_ENABLE_DEVTOOLS=OFF \
  -DJPEGLI_ENABLE_FUZZERS=OFF \
  -DJPEGLI_ENABLE_JNI=OFF \
  -DJPEGLI_ENABLE_OPENEXR=OFF \
  -DJPEGLI_ENABLE_SJPEG=OFF \
  -DJPEGLI_ENABLE_SKCMS=OFF \
  -DJPEGLI_FORCE_SYSTEM_HWY=ON \
  -Dhwy_DIR="$root/prefix/lib/cmake/hwy" \
  -DJPEGLI_FORCE_SYSTEM_LCMS2=ON \
  -DJPEGLI_ENABLE_JPEGLI_LIBJPEG=ON \
  -DJPEGLI_INSTALL_JPEGLI_LIBJPEG=ON \
  -DJPEGLI_ENABLE_HWY_AVX3=ON \
  -DJPEGLI_ENABLE_HWY_AVX3_ZEN4=ON \
  -DJPEGLI_ENABLE_HWY_SVE=OFF \
  -DJPEGLI_ENABLE_HWY_SVE2=OFF \
  -DJPEGLI_ENABLE_HWY_SVE2_128=ON \
  -DJPEGLI_LIBJPEG_LIBRARY_SOVERSION=62 \
  -DJPEGLI_LIBJPEG_LIBRARY_VERSION=62.3.0 \
  -DLIBJPEG_TURBO_VERSION_NUMBER=2001005
codec_cmake_build
cmake --install build
mkdir -p "$root/prefix/lib/pkgconfig"
cat > "$root/prefix/lib/pkgconfig/libjpeg.pc" <<EOF
prefix=$root/prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: libjpeg
Description: Pinned upstream jpegli libjpeg ABI 62
Version: 2.1.5
Libs: -L\${libdir} -ljpeg
Cflags: -I\${includedir}
EOF
# TIFF must use the same JPEG decoder as vips and ImageMagick, not Ubuntu's ABI 8 decoder.
cp -- "$root/sources/jpegli/third_party/libjpeg-turbo/jerror.h" "$root/prefix/include/"
)

build_tiff() (
cd "$root/sources/tiff"
tar -xf "$root/sources/tiff-debian.tar.xz"
while read -r patchfile; do
  if patch --dry-run --forward --batch -p1 < "debian/patches/$patchfile" >/dev/null 2>&1; then
    patch --forward --batch -p1 < "debian/patches/$patchfile"
  else
    patch --dry-run --reverse --batch -p1 < "debian/patches/$patchfile" >/dev/null
  fi
done < debian/patches/series
codec_cmake "${cmake_cache[@]}" -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$root/prefix" -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_SHARED_LIBS=ON -Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF \
  -DJPEG_INCLUDE_DIR="$root/prefix/include" -DJPEG_LIBRARY_RELEASE="$root/prefix/lib/libjpeg.so"
codec_cmake_build
cmake --install build
)

build_libraw() (
cd "$root/sources/libraw"
autoreconf --install
CC="$autotools_cc" CXX="$autotools_cxx" ./configure --prefix="$root/prefix" --disable-examples
make
MAKEFLAGS='' make -j1 install
)

build_libde265() (
cd "$root/sources/libde265-1.1.3"
codec_cmake "${cmake_cache[@]}" -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$root/prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DENABLE_SDL=OFF \
  -DENABLE_DECODER=OFF \
  -DENABLE_ENCODER=OFF \
  -DBUILD_SHARED_LIBS=ON
codec_cmake_build
cmake --install build
)

build_libheif() (
cd "$root/sources/libheif"
codec_cmake "${cmake_cache[@]}" --preset=release-noplugins -S . -B build \
  -DCMAKE_INSTALL_PREFIX="$root/prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DWITH_DAV1D=ON \
  -DWITH_AOM_DECODER=OFF \
  -DWITH_AOM_ENCODER=ON \
  -DWITH_X265=OFF \
  -DWITH_EXAMPLES=OFF \
  -DLIBDE265_INCLUDE_DIR="$root/prefix/include" \
  -DLIBDE265_LIBRARY="$root/prefix/lib/libde265.so" \
  -DWITH_LIBSHARPYUV=ON \
  -DENABLE_PARALLEL_TILE_DECODING=ON
codec_cmake_build
cmake --install build
)

build_libjxl() (
cd "$root/sources/libjxl"
codec_cmake "${cmake_cache[@]}" -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$root/prefix" -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=ON \
  -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF \
  -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF \
  -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF \
  -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_OPENEXR=OFF \
  -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_SKCMS=ON -DJPEGXL_ENABLE_PLUGINS=OFF \
  -DJPEGXL_FORCE_SYSTEM_HWY=ON -DJPEGXL_FORCE_SYSTEM_LCMS2=ON -DJPEGXL_FORCE_SYSTEM_BROTLI=ON \
  -Dhwy_DIR="$root/prefix/lib/cmake/hwy" \
  -DCMAKE_CXX_FLAGS="$CPPFLAGS" -DCMAKE_SHARED_LINKER_FLAGS="$LDFLAGS"
codec_cmake_build
cmake --install build
)

build_imagemagick() (
cd "$root/sources/imagemagick"
CC="$autotools_cc" CXX="$autotools_cxx" ./configure --prefix="$root/prefix" --with-modules --disable-docs CPPFLAGS="$CPPFLAGS -DMAGICK_LIBRAW_VERSION_TAIL=202502"
make
MAKEFLAGS='' make -j1 install
cp -- "$root/policy.xml" "$root/prefix/etc/ImageMagick-7/policy.xml"
)

build_libvips() (
cd "$root/sources/libvips"
patchfile="$root/libvips-patches/0001-put-other-loaders-ahead-of-dcrawload.patch"
if git apply --check "$patchfile"; then git apply "$patchfile"; else git apply --reverse --check "$patchfile"; fi
export CFLAGS="$CPPFLAGS"
export CXXFLAGS="$CPPFLAGS"
meson setup --clearcache --reconfigure build --buildtype=release --prefix="$root/prefix" --libdir=lib -Dintrospection=disabled -Dtiff=disabled -Djpeg-xl=enabled -Drsvg=enabled
ninja -C build -j"$OPENFRAME_BUILD_JOBS"
ninja -C build -j"$OPENFRAME_BUILD_JOBS" install
)

if [[ "${1:-}" == --execute ]]; then
  "build_$2"
  exit
fi

if [[ "${1:-}" == --library ]]; then
  library=$2
  start=$SECONDS
  echo "== $library == starting offset=$(( $(date +%s) - CODEC_BUILD_EPOCH ))s budget=$OPENFRAME_BUILD_JOBS" > "$root/logs/$library.status"
  status=0
  bash "$script" --execute "$library" > "$root/logs/$library.log" 2>&1 || status=$?
  echo "== $library == elapsed=$((SECONDS - start))s end=$(( $(date +%s) - CODEC_BUILD_EPOCH ))s status=$status" >> "$root/logs/$library.status"
  if ((status)); then
    echo "Codec library failed: $library (exit $status); stopping other libraries. Logs: $root/logs" >&2
    kill -USR1 "$CODEC_BUILD_PARENT"
  fi
  exit "$status"
fi

command -v setsid >/dev/null || { echo 'Codec builds require setsid' >&2; exit 1; }
libraries=(highway jpegli tiff libraw libde265 libheif libjxl imagemagick libvips)
logdir="$root/logs"
mkdir -p "$logdir"
for library in "${libraries[@]}"; do rm -f "$logdir/$library.status" "$logdir/$library.log"; done
makefile=$(mktemp "$logdir/graph.XXXXXX")
cat > "$makefile" <<'MAKEFILE'
.PHONY: all highway jpegli tiff libraw libde265 libheif libjxl imagemagick libvips
all: libvips
jpegli libjxl: highway
tiff libraw: jpegli
libheif: libde265
imagemagick: tiff libraw libheif libjxl
libvips: imagemagick
highway jpegli tiff libraw libde265 libheif libjxl imagemagick libvips:
	+@bash "$$CODEC_BUILD_SCRIPT" --library $@
MAKEFILE
OPENFRAME_BUILD_JOBS="$(codec_build_jobs)"
export OPENFRAME_BUILD_JOBS
export CODEC_BUILD_PARENT=$$ CODEC_BUILD_SCRIPT="$script" CODEC_BUILD_EPOCH
CODEC_BUILD_EPOCH=$(date +%s)
# Own the pool even when invoked by another build or a parallel CMake environment.
unset MAKEFLAGS MFLAGS CMAKE_BUILD_PARALLEL_LEVEL
scheduler=''
finish() {
  local library attempt
  trap '' USR1
  if [[ -n "$scheduler" ]]; then
    kill -TERM -- "-$scheduler" 2>/dev/null || true
    for ((attempt=0; attempt<20; attempt++)); do
      kill -0 -- "-$scheduler" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$scheduler" 2>/dev/null || true
    wait "$scheduler" 2>/dev/null || true
  fi
  rm -f "$makefile"
  for library in "${libraries[@]}"; do
    [[ -f "$logdir/$library.status" ]] || continue
    head -n1 "$logdir/$library.status"
    echo "== $library == output"
    cat "$logdir/$library.log"
    if [[ $(wc -l < "$logdir/$library.status") -gt 1 ]]; then
      tail -n1 "$logdir/$library.status"
    else
      echo "== $library == end=$(( $(date +%s) - CODEC_BUILD_EPOCH ))s status=cancelled"
    fi
  done
}
trap finish EXIT
trap 'exit 1' USR1
trap 'exit 130' INT
trap 'exit 143' TERM
# Recursive recipes preserve pipe jobserver descriptors on older GNU make too.
setsid make --no-print-directory -f "$makefile" -j"$OPENFRAME_BUILD_JOBS" &
scheduler=$!
status=0
wait "$scheduler" || status=$?
exit "$status"
