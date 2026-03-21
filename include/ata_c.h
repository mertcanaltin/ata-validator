#ifndef ATA_C_H
#define ATA_C_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ata_schema_s* ata_schema;

typedef struct {
  const char* data;
  size_t length;
} ata_string;

typedef struct {
  bool valid;
  size_t error_count;
} ata_result;

typedef struct {
  uint32_t major;
  uint32_t minor;
  uint32_t revision;
} ata_version_components;

// Compile a JSON Schema. Returns NULL on failure.
ata_schema ata_compile(const char* schema_json, size_t length);

// Free a compiled schema. NULL-safe.
void ata_schema_free(ata_schema schema);

// Validate JSON against a compiled schema.
ata_result ata_validate(ata_schema schema, const char* json, size_t length);

// Validate JSON against a schema string (compiles each time).
ata_result ata_validate_oneshot(const char* schema_json, size_t schema_length,
                                const char* json, size_t json_length);

// Get error message at index from last validation.
ata_string ata_get_error_message(size_t index);

// Get error path at index from last validation.
ata_string ata_get_error_path(size_t index);

// Version info
const char* ata_get_version(void);
ata_version_components ata_get_version_components(void);

#ifdef __cplusplus
}
#endif

#endif  // ATA_C_H
