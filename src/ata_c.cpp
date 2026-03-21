#include "ata_c.h"

#include "ata.h"

#include <string>
#include <vector>

// Thread-local storage for last validation errors
static thread_local std::vector<ata::validation_error> last_errors;

struct ata_schema_s {
  ata::schema_ref ref;
};

ata_schema ata_compile(const char* schema_json, size_t length) {
  auto ref = ata::compile(std::string_view(schema_json, length));
  if (!ref) return nullptr;
  auto* s = new (std::nothrow) ata_schema_s;
  if (!s) return nullptr;
  s->ref = std::move(ref);
  return s;
}

void ata_schema_free(ata_schema schema) {
  delete schema;
}

ata_result ata_validate(ata_schema schema, const char* json, size_t length) {
  if (!schema) {
    last_errors.clear();
    return {false, 0};
  }
  auto result = ata::validate(schema->ref, std::string_view(json, length));
  last_errors = std::move(result.errors);
  return {result.valid, last_errors.size()};
}

ata_result ata_validate_oneshot(const char* schema_json, size_t schema_length,
                                const char* json, size_t json_length) {
  auto result = ata::validate(std::string_view(schema_json, schema_length),
                               std::string_view(json, json_length));
  last_errors = std::move(result.errors);
  return {result.valid, last_errors.size()};
}

ata_string ata_get_error_message(size_t index) {
  if (index >= last_errors.size()) return {nullptr, 0};
  return {last_errors[index].message.c_str(),
          last_errors[index].message.size()};
}

ata_string ata_get_error_path(size_t index) {
  if (index >= last_errors.size()) return {nullptr, 0};
  return {last_errors[index].path.c_str(), last_errors[index].path.size()};
}

const char* ata_get_version(void) {
  return "0.1.0";
}

ata_version_components ata_get_version_components(void) {
  return {ata::VERSION_MAJOR, ata::VERSION_MINOR, ata::VERSION_REVISION};
}
