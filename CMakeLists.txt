cmake_minimum_required(VERSION 3.28)
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

# RE2 — fast regex engine (replaces std::regex)
set(RE2_BUILD_TESTING OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  re2
  GIT_REPOSITORY https://github.com/google/re2.git
  GIT_TAG 2024-07-02
  GIT_SHALLOW TRUE
  EXCLUDE_FROM_ALL
)

# Abseil — required by RE2
set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(ABSL_ENABLE_INSTALL ON CACHE BOOL "" FORCE)
FetchContent_Declare(
  abseil-cpp
  GIT_REPOSITORY https://github.com/abseil/abseil-cpp.git
  GIT_TAG 20240722.0
  GIT_SHALLOW TRUE
)

FetchContent_MakeAvailable(abseil-cpp)
FetchContent_MakeAvailable(simdjson re2)

include_directories(${CMAKE_JS_INC})
file(GLOB SOURCE_FILES "binding/*.cpp" "src/*.cpp" "deps/simdjson/*.cpp")

# Core library
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
target_include_directories(${PROJECT_NAME} PUBLIC include)
target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC})
target_link_libraries(${PROJECT_NAME} PRIVATE simdjson re2)
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

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
