cmake_minimum_required(VERSION 3.16)
project(ata VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(ATA_TESTING "Build test suite" ON)
option(ATA_BENCHMARKS "Build benchmarks" OFF)
option(ATA_SANITIZE "Enable address sanitizer" OFF)

# Fetch simdjson
include(FetchContent)
FetchContent_Declare(
  simdjson
  GIT_REPOSITORY https://github.com/simdjson/simdjson.git
  GIT_TAG v3.12.2
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(simdjson)

# Core library
add_library(ata
  src/ata.cpp
  src/ata_c.cpp
)
target_include_directories(ata PUBLIC include)
target_link_libraries(ata PRIVATE simdjson)
add_library(ata::ata ALIAS ata)

if(ATA_SANITIZE)
  target_compile_options(ata PRIVATE -fsanitize=address -fno-omit-frame-pointer)
  target_link_options(ata PRIVATE -fsanitize=address)
endif()

# Tests
if(ATA_TESTING)
  enable_testing()
  add_executable(ata_tests tests/test.cpp)
  target_link_libraries(ata_tests PRIVATE ata simdjson)
  if(ATA_SANITIZE)
    target_compile_options(ata_tests PRIVATE -fsanitize=address -fno-omit-frame-pointer)
    target_link_options(ata_tests PRIVATE -fsanitize=address)
  endif()
  add_test(NAME ata_tests COMMAND ata_tests)
endif()

# Benchmarks
if(ATA_BENCHMARKS)
  add_executable(ata_bench benchmark/bench.cpp)
  target_link_libraries(ata_bench PRIVATE ata simdjson)
endif()
