#include <cstdint>
#include <cstddef>
#include <string_view>
#include "ata.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  auto schema = ata::compile(
      std::string_view(reinterpret_cast<const char *>(data), size));
  return 0;
}
