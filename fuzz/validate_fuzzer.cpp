#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include "ata.h"

static const char *kSchemas[] = {
    R"({"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer","minimum":0}},"required":["name"]})",
    R"({"type":"array","items":{"type":"number"},"minItems":1,"maxItems":10})",
    R"({"type":"string","minLength":1,"maxLength":100,"format":"email"})",
    R"({"oneOf":[{"type":"string"},{"type":"number"}]})",
    R"({"type":"object","additionalProperties":false,"properties":{"id":{"type":"integer"}}})",
};

static constexpr size_t kSchemaCount = sizeof(kSchemas) / sizeof(kSchemas[0]);
static ata::schema_ref compiled[kSchemaCount];
static bool initialized = false;

static void init() {
  for (size_t i = 0; i < kSchemaCount; i++) {
    compiled[i] = ata::compile(kSchemas[i]);
  }
  initialized = true;
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (!initialized) init();
  if (size < 2) return 0;

  size_t idx = data[0] % kSchemaCount;
  std::string_view json(reinterpret_cast<const char *>(data + 1), size - 1);

  if (compiled[idx]) {
    ata::validate(compiled[idx], json);
  }
  return 0;
}
