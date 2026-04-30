#include "ata.h"

#include <cassert>
#include <cstdio>
#include <string_view>

static int tests_run = 0;
static int tests_passed = 0;

#define TEST(name) \
  static void test_##name(); \
  static struct test_reg_##name { \
    test_reg_##name() { \
      ++tests_run; \
      printf("  %-50s ", #name); \
      test_##name(); \
      ++tests_passed; \
      printf("PASS\n"); \
    } \
  } test_reg_instance_##name; \
  static void test_##name()

#define ASSERT(cond) \
  do { \
    if (!(cond)) { \
      printf("FAIL\n    assertion failed: %s\n    at %s:%d\n", #cond, \
             __FILE__, __LINE__); \
      std::exit(1); \
    } \
  } while (0)

// --- Type validation ---

TEST(type_string_valid) {
  auto r = ata::validate(R"({"type": "string"})", R"("hello")");
  ASSERT(r.valid);
}

TEST(type_string_invalid) {
  auto r = ata::validate(R"({"type": "string"})", "42");
  ASSERT(!r.valid);
  ASSERT(r.errors[0].code == ata::error_code::type_mismatch);
}

TEST(type_number_valid) {
  auto r = ata::validate(R"({"type": "number"})", "3.14");
  ASSERT(r.valid);
}

TEST(type_number_accepts_integer) {
  auto r = ata::validate(R"({"type": "number"})", "42");
  ASSERT(r.valid);
}

TEST(type_integer_valid) {
  auto r = ata::validate(R"({"type": "integer"})", "42");
  ASSERT(r.valid);
}

TEST(type_integer_rejects_float) {
  auto r = ata::validate(R"({"type": "integer"})", "3.14");
  ASSERT(!r.valid);
}

TEST(type_boolean_valid) {
  auto r = ata::validate(R"({"type": "boolean"})", "true");
  ASSERT(r.valid);
}

TEST(type_null_valid) {
  auto r = ata::validate(R"({"type": "null"})", "null");
  ASSERT(r.valid);
}

TEST(type_array_valid) {
  auto r = ata::validate(R"({"type": "array"})", "[1, 2, 3]");
  ASSERT(r.valid);
}

TEST(type_object_valid) {
  auto r = ata::validate(R"({"type": "object"})", R"({"a": 1})");
  ASSERT(r.valid);
}

TEST(type_union) {
  auto r = ata::validate(R"({"type": ["string", "number"]})", R"("hi")");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type": ["string", "number"]})", "42");
  ASSERT(r2.valid);
  auto r3 = ata::validate(R"({"type": ["string", "number"]})", "true");
  ASSERT(!r3.valid);
}

// --- Numeric constraints ---

TEST(minimum) {
  auto r = ata::validate(R"({"type":"number","minimum":5})", "5");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"number","minimum":5})", "4");
  ASSERT(!r2.valid);
}

TEST(maximum) {
  auto r = ata::validate(R"({"type":"number","maximum":10})", "10");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"number","maximum":10})", "11");
  ASSERT(!r2.valid);
}

TEST(exclusive_minimum) {
  auto r = ata::validate(R"({"type":"number","exclusiveMinimum":5})", "6");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"number","exclusiveMinimum":5})", "5");
  ASSERT(!r2.valid);
}

TEST(exclusive_maximum) {
  auto r = ata::validate(R"({"type":"number","exclusiveMaximum":10})", "9");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"number","exclusiveMaximum":10})", "10");
  ASSERT(!r2.valid);
}

TEST(multiple_of) {
  auto r = ata::validate(R"({"type":"number","multipleOf":3})", "9");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"number","multipleOf":3})", "10");
  ASSERT(!r2.valid);
}

// --- String constraints ---

TEST(min_length) {
  auto r = ata::validate(R"({"type":"string","minLength":3})", R"("abc")");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"string","minLength":3})", R"("ab")");
  ASSERT(!r2.valid);
}

TEST(max_length) {
  auto r = ata::validate(R"({"type":"string","maxLength":5})", R"("hello")");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"string","maxLength":5})", R"("helloo")");
  ASSERT(!r2.valid);
}

TEST(pattern) {
  auto r = ata::validate(R"({"type":"string","pattern":"^[a-z]+$"})", R"("abc")");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"string","pattern":"^[a-z]+$"})", R"("ABC")");
  ASSERT(!r2.valid);
}

// --- Array constraints ---

TEST(min_items) {
  auto r = ata::validate(R"({"type":"array","minItems":2})", "[1,2]");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"array","minItems":2})", "[1]");
  ASSERT(!r2.valid);
}

TEST(max_items) {
  auto r = ata::validate(R"({"type":"array","maxItems":3})", "[1,2,3]");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"array","maxItems":3})", "[1,2,3,4]");
  ASSERT(!r2.valid);
}

TEST(unique_items) {
  auto r = ata::validate(R"({"type":"array","uniqueItems":true})", "[1,2,3]");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"array","uniqueItems":true})", "[1,2,1]");
  ASSERT(!r2.valid);
}

TEST(items_schema) {
  auto r = ata::validate(R"({"type":"array","items":{"type":"number"}})", "[1,2,3]");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"array","items":{"type":"number"}})", R"([1,"a",3])");
  ASSERT(!r2.valid);
}

// --- Object constraints ---

TEST(required_properties) {
  auto schema = R"({"type":"object","required":["name","age"]})";
  auto r = ata::validate(schema, R"({"name":"mert","age":25})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"name":"mert"})");
  ASSERT(!r2.valid);
  ASSERT(r2.errors[0].code == ata::error_code::required_property_missing);
}

TEST(properties_validation) {
  auto schema = R"({
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "age": {"type": "integer"}
    }
  })";
  auto r = ata::validate(schema, R"({"name":"mert","age":25})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"name":123,"age":"old"})");
  ASSERT(!r2.valid);
}

TEST(additional_properties_false) {
  auto schema = R"({
    "type": "object",
    "properties": {"name": {"type": "string"}},
    "additionalProperties": false
  })";
  auto r = ata::validate(schema, R"({"name":"mert"})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"name":"mert","extra":1})");
  ASSERT(!r2.valid);
}

TEST(additional_properties_did_you_mean_typo) {
  auto schema = R"({
    "type": "object",
    "properties": {"name": {}},
    "additionalProperties": false
  })";
  auto r = ata::validate(schema, R"({"naem": 1})");
  ASSERT(!r.valid);
  ASSERT(r.errors.size() == 1);
  ASSERT(r.errors[0].code == ata::error_code::additional_property_not_allowed);
  ASSERT(r.errors[0].message.find("did you mean \"name\"") != std::string::npos);
}

TEST(additional_properties_did_you_mean_prefix) {
  auto schema = R"({
    "type": "object",
    "properties": {"test": {}, "watch": {}, "permission": {}},
    "additionalProperties": false
  })";
  auto r = ata::validate(schema, R"({"testRunner": 1})");
  ASSERT(!r.valid);
  ASSERT(r.errors.size() == 1);
  ASSERT(r.errors[0].message.find("did you mean \"test\"") != std::string::npos);
}

TEST(additional_properties_no_suggestion_when_far) {
  auto schema = R"({
    "type": "object",
    "properties": {"name": {}},
    "additionalProperties": false
  })";
  auto r = ata::validate(schema, R"({"completelyUnrelated": 1})");
  ASSERT(!r.valid);
  ASSERT(r.errors.size() == 1);
  // No "did you mean" hint when nothing is close
  ASSERT(r.errors[0].message == "additional property not allowed: completelyUnrelated");
}

TEST(additional_properties_did_you_mean_multiple_candidates) {
  // "tests" is one edit from "test" and one edit from "tests" if it existed.
  // We only have "test" — should suggest it.
  auto schema = R"({
    "type": "object",
    "properties": {"test": {}, "watch": {}},
    "additionalProperties": false
  })";
  auto r = ata::validate(schema, R"({"tests": 1})");
  ASSERT(!r.valid);
  ASSERT(r.errors[0].message.find("did you mean \"test\"") != std::string::npos);
}

TEST(additional_properties_schema) {
  auto schema = R"({
    "type": "object",
    "properties": {"name": {"type": "string"}},
    "additionalProperties": {"type": "number"}
  })";
  auto r = ata::validate(schema, R"({"name":"mert","score":100})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"name":"mert","extra":"nope"})");
  ASSERT(!r2.valid);
}

TEST(min_max_properties) {
  auto r = ata::validate(R"({"type":"object","minProperties":2})", R"({"a":1,"b":2})");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"type":"object","minProperties":2})", R"({"a":1})");
  ASSERT(!r2.valid);
}

// --- Enum / Const ---

TEST(enum_valid) {
  auto r = ata::validate(R"({"enum":["red","green","blue"]})", R"("green")");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"enum":["red","green","blue"]})", R"("yellow")");
  ASSERT(!r2.valid);
}

TEST(enum_numbers) {
  auto r = ata::validate(R"({"enum":[1,2,3]})", "2");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"enum":[1,2,3]})", "4");
  ASSERT(!r2.valid);
}

TEST(const_valid) {
  auto r = ata::validate(R"({"const":"hello"})", R"("hello")");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"const":"hello"})", R"("world")");
  ASSERT(!r2.valid);
}

// --- Composition ---

TEST(all_of) {
  auto schema = R"({
    "allOf": [
      {"type": "number"},
      {"minimum": 5},
      {"maximum": 10}
    ]
  })";
  auto r = ata::validate(schema, "7");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, "3");
  ASSERT(!r2.valid);
}

TEST(any_of) {
  auto schema = R"({
    "anyOf": [
      {"type": "string"},
      {"type": "number"}
    ]
  })";
  auto r = ata::validate(schema, R"("hello")");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, "42");
  ASSERT(r2.valid);
  auto r3 = ata::validate(schema, "true");
  ASSERT(!r3.valid);
}

TEST(one_of) {
  auto schema = R"({
    "oneOf": [
      {"type": "number", "multipleOf": 3},
      {"type": "number", "multipleOf": 5}
    ]
  })";
  auto r = ata::validate(schema, "9");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, "10");
  ASSERT(r2.valid);
  auto r3 = ata::validate(schema, "15");  // matches both
  ASSERT(!r3.valid);
}

TEST(not_schema) {
  auto r = ata::validate(R"({"not":{"type":"string"}})", "42");
  ASSERT(r.valid);
  auto r2 = ata::validate(R"({"not":{"type":"string"}})", R"("hello")");
  ASSERT(!r2.valid);
}

// --- $ref ---

TEST(ref_defs) {
  auto schema = R"({
    "$defs": {
      "pos_int": {"type": "integer", "minimum": 0}
    },
    "type": "object",
    "properties": {
      "age": {"$ref": "#/$defs/pos_int"}
    }
  })";
  auto r = ata::validate(schema, R"({"age": 25})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"age": -1})");
  ASSERT(!r2.valid);
}

// --- if/then/else ---

TEST(if_then_else) {
  auto schema = R"({
    "type": "object",
    "properties": {
      "type": {"type": "string"},
      "value": {}
    },
    "if": {
      "properties": {"type": {"const": "string"}}
    },
    "then": {
      "properties": {"value": {"type": "string"}}
    },
    "else": {
      "properties": {"value": {"type": "number"}}
    }
  })";
  auto r = ata::validate(schema, R"({"type":"string","value":"hello"})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"type":"number","value":42})");
  ASSERT(r2.valid);
}

// --- Boolean schema ---

TEST(boolean_schema_true) {
  auto r = ata::validate("true", "42");
  ASSERT(r.valid);
}

TEST(boolean_schema_false) {
  auto r = ata::validate("false", "42");
  ASSERT(!r.valid);
}

// --- Invalid input ---

TEST(invalid_json) {
  auto r = ata::validate(R"({"type":"string"})", "{broken");
  ASSERT(!r.valid);
  ASSERT(r.errors[0].code == ata::error_code::invalid_json);
}

TEST(invalid_schema) {
  auto r = ata::validate("{broken", R"("hello")");
  ASSERT(!r.valid);
  ASSERT(r.errors[0].code == ata::error_code::invalid_schema);
}

// --- Compiled schema reuse ---

TEST(compiled_schema_reuse) {
  auto schema = ata::compile(R"({"type":"string","minLength":2})");
  ASSERT(schema);

  auto r1 = ata::validate(schema, R"("hello")");
  ASSERT(r1.valid);

  auto r2 = ata::validate(schema, R"("a")");
  ASSERT(!r2.valid);

  auto r3 = ata::validate(schema, "42");
  ASSERT(!r3.valid);
}

// --- patternProperties ---

TEST(pattern_properties) {
  auto schema = R"({
    "type": "object",
    "patternProperties": {
      "^S_": {"type": "string"},
      "^I_": {"type": "integer"}
    },
    "additionalProperties": false
  })";
  auto r = ata::validate(schema, R"({"S_name":"mert","I_age":25})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"S_name":123})");
  ASSERT(!r2.valid);
  auto r3 = ata::validate(schema, R"({"unknown":1})");
  ASSERT(!r3.valid);
}

// --- format ---

TEST(format_email) {
  auto schema = R"({"type":"string","format":"email"})";
  auto r = ata::validate(schema, R"("user@example.com")");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"("not-an-email")");
  ASSERT(!r2.valid);
}

TEST(format_date) {
  auto schema = R"({"type":"string","format":"date"})";
  auto r = ata::validate(schema, R"("2026-03-21")");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"("not-a-date")");
  ASSERT(!r2.valid);
}

TEST(format_datetime) {
  auto schema = R"({"type":"string","format":"date-time"})";
  auto r = ata::validate(schema, R"("2026-03-21T10:30:00Z")");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"("nope")");
  ASSERT(!r2.valid);
}

TEST(format_uri) {
  auto schema = R"({"type":"string","format":"uri"})";
  auto r = ata::validate(schema, R"("https://example.com")");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"("not a uri")");
  ASSERT(!r2.valid);
}

TEST(format_ipv4) {
  auto schema = R"({"type":"string","format":"ipv4"})";
  auto r = ata::validate(schema, R"("192.168.1.1")");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"("nope")");
  ASSERT(!r2.valid);
}

TEST(format_uuid) {
  auto schema = R"({"type":"string","format":"uuid"})";
  auto r = ata::validate(schema, R"("550e8400-e29b-41d4-a716-446655440000")");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"("not-a-uuid")");
  ASSERT(!r2.valid);
}

TEST(format_hostname) {
  auto schema = R"({"type":"string","format":"hostname"})";
  auto r = ata::validate(schema, R"("example.com")");
  ASSERT(r.valid);
}

// --- $id / $ref ---

TEST(id_and_ref) {
  auto schema = R"({
    "$defs": {
      "address": {
        "$id": "#address",
        "type": "object",
        "properties": {
          "city": {"type": "string"}
        },
        "required": ["city"]
      }
    },
    "type": "object",
    "properties": {
      "home": {"$ref": "#/$defs/address"}
    }
  })";
  auto r = ata::validate(schema, R"({"home":{"city":"Istanbul"}})");
  ASSERT(r.valid);
  auto r2 = ata::validate(schema, R"({"home":{}})");
  ASSERT(!r2.valid);
}

// --- Empty schema (accepts everything) ---

TEST(empty_schema) {
  auto r = ata::validate("{}", "42");
  ASSERT(r.valid);
  auto r2 = ata::validate("{}", R"("hello")");
  ASSERT(r2.valid);
  auto r3 = ata::validate("{}", "null");
  ASSERT(r3.valid);
}

int main() {
  printf("\nata v%.*s - JSON Schema Validator Tests\n",
         static_cast<int>(ata::version().size()), ata::version().data());
  printf("=========================================\n\n");
  printf("\n%d/%d tests passed.\n\n", tests_passed, tests_run);
  return tests_passed == tests_run ? 0 : 1;
}
