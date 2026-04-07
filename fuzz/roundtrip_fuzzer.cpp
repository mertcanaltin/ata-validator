#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include "ata.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size < 4) return 0;

  // first half is schema, second half is document
  size_t mid = size / 2;
  std::string_view schema_json(reinterpret_cast<const char *>(data), mid);
  std::string_view doc_json(reinterpret_cast<const char *>(data + mid),
                            size - mid);

  auto schema = ata::compile(schema_json);
  if (schema) {
    ata::validate(schema, doc_json);
    ata::validate(schema, doc_json, {.all_errors = false});
  }
  return 0;
}
