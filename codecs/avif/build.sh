#!/bin/bash
# Runs inside emscripten/emsdk, started by build.ts: /kit is this folder, /src the checked source archives, /out where the encoder is written.
set -euo pipefail
umask 000

B=/tmp/build
WEBP=$B/libavif/ext/libwebp
FLAGS="-O3 -flto -msimd128 -msse4.1"
J=$(nproc)

mkdir -p $B/libavif $B/libaom $WEBP
tar xzf /src/libavif.tar.gz --strip-components 1 -C $B/libavif
tar xzf /src/libaom.tar.gz --strip-components 1 -C $B/libaom
tar xzf /src/libwebp.tar.gz --strip-components 1 -C $WEBP

# libaom's SSE2 to SSE4.1 intrinsics compile to wasm SIMD through Emscripten's SSE headers, once its x86 target is accepted: inline asm stubbed, the NASM files left empty, and the functions they alone define dropped from the dispatch tables, so those fall back to C.
perl -0pi /kit/x86-emscripten.pl $B/libaom/aom_ports/x86.h
perl -0pi /kit/rtcd-skip.pl $B/libaom/cmake/rtcd.pl
# A patch that no longer matches a new libaom changes nothing: the rtcd one would only fail at the link, so both are checked here, and an x86 inline asm left unpatched stops the compile on its own.
grep -q __EMSCRIPTEN__ $B/libaom/aom_ports/x86.h || { echo "x86-emscripten.pl did not apply" >&2; exit 1; }
grep -q AOM_RTCD_SKIP $B/libaom/cmake/rtcd.pl || { echo "rtcd-skip.pl did not apply" >&2; exit 1; }
export PATH=/kit/nasm:$PATH AOM_RTCD_SKIP=/kit/asm-only.txt
export CFLAGS="$FLAGS" CXXFLAGS="$FLAGS" LDFLAGS="$FLAGS"

emcmake cmake -S $WEBP -B $WEBP/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWEBP_USE_THREAD=OFF -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_LIBWEBPMUX=OFF -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF
make -C $WEBP/build -j"$J" sharpyuv

# 8-bit only: a high bit depth build writes the same bytes from a wasm a third larger.
emcmake cmake -S $B/libaom -B $B/libaom-build -DCMAKE_BUILD_TYPE=Release -DAOM_TARGET_CPU=x86 -DENABLE_NASM=1 -DENABLE_AVX=0 -DENABLE_AVX2=0 -DENABLE_SSE4_2=0 -DENABLE_CCACHE=0 -DENABLE_DOCS=0 -DENABLE_TESTS=0 -DENABLE_EXAMPLES=0 -DENABLE_TOOLS=0 -DCONFIG_INSPECTION=0 -DCONFIG_RUNTIME_CPU_DETECT=0 -DCONFIG_WEBM_IO=0 -DCONFIG_AV1_DECODER=0 -DCONFIG_MULTITHREAD=0 -DCONFIG_AV1_HIGHBITDEPTH=0
make -C $B/libaom-build -j"$J" aom

emcmake cmake -S $B/libavif -B $B/libavif-build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DAVIF_CODEC_AOM=SYSTEM -DAVIF_CODEC_AOM_DECODE=OFF -DAOM_LIBRARY=$B/libaom-build/libaom.a -DAOM_INCLUDE_DIR=$B/libaom -DAVIF_LIBSHARPYUV=LOCAL -DAVIF_LIBYUV=OFF
make -C $B/libavif-build -j"$J"

# A symbol left undefined would trap at run time: the link fails on it instead, naming the asm-only functions a new libaom adds to asm-only.txt.
emcc $FLAGS /kit/encode.c -I $B/libavif/include $B/libavif-build/libavif.a $B/libaom-build/libaom.a $WEBP/build/libsharpyuv.a \
  -s ERROR_ON_UNDEFINED_SYMBOLS=1 -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 -s STACK_SIZE=5242880 -s INITIAL_MEMORY=16777216 \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=worker -s DYNAMIC_EXECUTION=0 \
  -s EXPORTED_FUNCTIONS=_malloc,_free,_kay_avif_encode,_kay_avif_output,_kay_avif_error -s EXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString \
  -o /out/avif-enc.js
