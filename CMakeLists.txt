cmake_minimum_required(VERSION 3.28)
cmake_policy(SET CMP0091 NEW)
cmake_policy(SET CMP0042 NEW)

project(ata VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS True)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(MSVC)
  set(ABSL_MSVC_STATIC_RUNTIME ON)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>" CACHE STRING "" FORCE)
  set(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS ON)
endif()

option(ATA_TESTING "Build test suite" ON)
option(ATA_BENCHMARKS "Build benchmarks" OFF)
option(ATA_SANITIZE "Enable address sanitizer" OFF)
option(ATA_NO_RE2 "Build without RE2 regex engine (disables pattern keyword)" OFF)

# Fetch simdjson
include(FetchContent)
FetchContent_Declare(
  simdjson
  GIT_REPOSITORY https://github.com/simdjson/simdjson.git
  GIT_TAG v4.5.0
  GIT_SHALLOW TRUE
)

if(NOT ATA_NO_RE2)
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

  FetchContent_MakeAvailable(abseil-cpp simdjson re2)
else()
  FetchContent_MakeAvailable(simdjson)
endif()

if (CMAKE_JS_VERSION)
  # add_definitions(-DNAPI_VERSION=10)
  include_directories(${CMAKE_JS_INC})
  file(GLOB SOURCE_FILES "binding/*.cpp" "src/*.cpp")
else()
  file(GLOB SOURCE_FILES "src/*.cpp")
endif()


if (CMAKE_JS_VERSION)
  add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})

  # Include Node-API wrappers
  execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
  )

  string(REGEX REPLACE "[\r\n\"]" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
  target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})

  # Include Node-API C headers
  execute_process(
    COMMAND node -p "require('node-api-headers').include_dir"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_API_HEADERS_DIR
  )

  string(REGEX REPLACE "[\r\n\"]" "" NODE_API_HEADERS_DIR ${NODE_API_HEADERS_DIR})
  target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_API_HEADERS_DIR})
else()
  add_library(${PROJECT_NAME} ${SOURCE_FILES})
endif()

target_include_directories(${PROJECT_NAME} PUBLIC include)
if(ATA_NO_RE2)
  target_link_libraries(${PROJECT_NAME} PRIVATE simdjson)
  target_compile_definitions(${PROJECT_NAME} PRIVATE ATA_NO_RE2)
else()
  target_link_libraries(${PROJECT_NAME} PRIVATE simdjson re2)
endif()

if (CMAKE_JS_VERSION)
  target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC})
  target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB})
  set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
endif()

add_library(ata::ata ALIAS ata)

if(CMAKE_JS_VERSION AND UNIX AND NOT APPLE)
  target_compile_options(${PROJECT_NAME} PRIVATE -fvisibility=hidden -fvisibility-inlines-hidden)
  target_link_options(${PROJECT_NAME} PRIVATE -Wl,--exclude-libs,ALL)
endif()

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  # Generate node.lib
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()

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

# Fuzz targets (for OSS-Fuzz / libFuzzer)
if(ATA_FUZZING)
  foreach(fuzzer compile_fuzzer validate_fuzzer roundtrip_fuzzer)
    add_executable(${fuzzer} fuzz/${fuzzer}.cpp)
    target_link_libraries(${fuzzer} PRIVATE ata simdjson ${LIB_FUZZING_ENGINE})
  endforeach()
endif()
