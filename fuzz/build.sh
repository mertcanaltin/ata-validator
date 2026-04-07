#!/bin/bash -eu

cd $SRC/ata-validator

mkdir -p build
cd build

cmake .. \
  -DCMAKE_C_COMPILER=$CC \
  -DCMAKE_CXX_COMPILER=$CXX \
  -DCMAKE_C_FLAGS="$CFLAGS" \
  -DCMAKE_CXX_FLAGS="$CXXFLAGS" \
  -DCMAKE_BUILD_TYPE=Release \
  -DATA_TESTING=OFF \
  -DATA_BENCHMARKS=OFF \
  -DATA_FUZZING=OFF \
  -DBUILD_SHARED_LIBS=OFF

cmake --build . --config Release -j$(nproc) --target ata

cd $SRC/ata-validator

for fuzzer in compile_fuzzer validate_fuzzer roundtrip_fuzzer; do
  $CXX $CXXFLAGS -std=c++20 \
    -I include -I build/_deps/simdjson-src/singleheader \
    -c fuzz/${fuzzer}.cpp -o ${fuzzer}.o
  $CXX $CXXFLAGS ${fuzzer}.o \
    build/libata.a \
    build/_deps/simdjson-build/libsimdjson.a \
    $LIB_FUZZING_ENGINE \
    -o $OUT/${fuzzer}
done

cp fuzz/json.dict $OUT/
