#include "ata.h"

#include <algorithm>
#include <cmath>
#include <regex>
#include <set>
#include <unordered_map>

#include "simdjson.h"

// --- Fast format validators (no std::regex) ---

static bool is_digit(char c) { return c >= '0' && c <= '9'; }
static bool is_alpha(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
static bool is_alnum(char c) { return is_alpha(c) || is_digit(c); }
static bool is_hex(char c) {
  return is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static bool fast_check_email(std::string_view s) {
  auto at = s.find('@');
  if (at == std::string_view::npos || at == 0 || at == s.size() - 1)
    return false;
  auto dot = s.find('.', at + 1);
  if (dot == std::string_view::npos || dot == at + 1 ||
      dot == s.size() - 1)
    return false;
  // Check TLD has at least 2 chars
  return (s.size() - dot - 1) >= 2;
}

static bool fast_check_date(std::string_view s) {
  // YYYY-MM-DD
  return s.size() == 10 && is_digit(s[0]) && is_digit(s[1]) &&
         is_digit(s[2]) && is_digit(s[3]) && s[4] == '-' &&
         is_digit(s[5]) && is_digit(s[6]) && s[7] == '-' &&
         is_digit(s[8]) && is_digit(s[9]);
}

static bool fast_check_time(std::string_view s) {
  // HH:MM:SS[.frac][Z|+HH:MM]
  if (s.size() < 8) return false;
  if (!is_digit(s[0]) || !is_digit(s[1]) || s[2] != ':' ||
      !is_digit(s[3]) || !is_digit(s[4]) || s[5] != ':' ||
      !is_digit(s[6]) || !is_digit(s[7]))
    return false;
  return true;
}

static bool fast_check_datetime(std::string_view s) {
  if (s.size() < 19) return false;
  if (!fast_check_date(s.substr(0, 10))) return false;
  if (s[10] != 'T' && s[10] != 't' && s[10] != ' ') return false;
  return fast_check_time(s.substr(11));
}

static bool fast_check_ipv4(std::string_view s) {
  int parts = 0, val = 0, digits = 0;
  for (size_t i = 0; i <= s.size(); ++i) {
    if (i == s.size() || s[i] == '.') {
      if (digits == 0 || val > 255) return false;
      ++parts;
      val = 0;
      digits = 0;
    } else if (is_digit(s[i])) {
      val = val * 10 + (s[i] - '0');
      ++digits;
      if (digits > 3) return false;
    } else {
      return false;
    }
  }
  return parts == 4;
}

static bool fast_check_uri(std::string_view s) {
  if (s.size() < 3) return false;
  // Must start with alpha, then scheme chars, then ':'
  if (!is_alpha(s[0])) return false;
  size_t i = 1;
  while (i < s.size() && (is_alnum(s[i]) || s[i] == '+' || s[i] == '-' ||
                           s[i] == '.'))
    ++i;
  return i < s.size() && s[i] == ':' && i + 1 < s.size();
}

static bool fast_check_uuid(std::string_view s) {
  // 8-4-4-4-12
  if (s.size() != 36) return false;
  for (size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (s[i] != '-') return false;
    } else {
      if (!is_hex(s[i])) return false;
    }
  }
  return true;
}

static bool fast_check_hostname(std::string_view s) {
  if (s.empty() || s.size() > 253) return false;
  size_t label_len = 0;
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '.') {
      if (label_len == 0) return false;
      label_len = 0;
    } else if (is_alnum(s[i]) || s[i] == '-') {
      ++label_len;
      if (label_len > 63) return false;
    } else {
      return false;
    }
  }
  return label_len > 0;
}

static bool check_format(std::string_view sv, const std::string& fmt) {
  if (fmt == "email") return fast_check_email(sv);
  if (fmt == "date") return fast_check_date(sv);
  if (fmt == "date-time") return fast_check_datetime(sv);
  if (fmt == "time") return fast_check_time(sv);
  if (fmt == "ipv4") return fast_check_ipv4(sv);
  if (fmt == "ipv6") return sv.find(':') != std::string_view::npos;
  if (fmt == "uri" || fmt == "uri-reference") return fast_check_uri(sv);
  if (fmt == "uuid") return fast_check_uuid(sv);
  if (fmt == "hostname") return fast_check_hostname(sv);
  return true;  // unknown formats pass
}

namespace ata {

using namespace simdjson;

// Forward declarations
struct schema_node;
using schema_node_ptr = std::shared_ptr<schema_node>;

struct schema_node {
  // type constraint: "string", "number", "integer", "boolean", "null",
  // "object", "array"
  std::vector<std::string> types;

  // numeric
  std::optional<double> minimum;
  std::optional<double> maximum;
  std::optional<double> exclusive_minimum;
  std::optional<double> exclusive_maximum;
  std::optional<double> multiple_of;

  // string
  std::optional<uint64_t> min_length;
  std::optional<uint64_t> max_length;
  std::optional<std::string> pattern;
  std::shared_ptr<std::regex> compiled_pattern;  // cached compiled regex

  // array
  std::optional<uint64_t> min_items;
  std::optional<uint64_t> max_items;
  bool unique_items = false;
  schema_node_ptr items_schema;
  std::vector<schema_node_ptr> prefix_items;

  // object
  std::unordered_map<std::string, schema_node_ptr> properties;
  std::vector<std::string> required;
  std::optional<bool> additional_properties_bool;
  schema_node_ptr additional_properties_schema;
  std::optional<uint64_t> min_properties;
  std::optional<uint64_t> max_properties;

  // patternProperties
  std::vector<std::pair<std::string, schema_node_ptr>> pattern_properties;

  // enum / const
  std::optional<std::string> enum_values_raw;  // raw JSON array string
  std::vector<std::string> enum_values_minified;  // pre-minified enum values
  std::optional<std::string> const_value_raw;  // raw JSON value string

  // format
  std::optional<std::string> format;

  // composition
  std::vector<schema_node_ptr> all_of;
  std::vector<schema_node_ptr> any_of;
  std::vector<schema_node_ptr> one_of;
  schema_node_ptr not_schema;

  // conditional
  schema_node_ptr if_schema;
  schema_node_ptr then_schema;
  schema_node_ptr else_schema;

  // $ref
  std::string ref;

  // boolean schema
  std::optional<bool> boolean_schema;
};

struct compiled_schema {
  schema_node_ptr root;
  std::unordered_map<std::string, schema_node_ptr> defs;
  std::string raw_schema;
  dom::parser parser;
  dom::parser doc_parser;  // reusable parser for document validation
};

// --- Schema compilation ---

static schema_node_ptr compile_node(dom::element el,
                                    compiled_schema& ctx);

static schema_node_ptr compile_node(dom::element el,
                                    compiled_schema& ctx) {
  auto node = std::make_shared<schema_node>();

  // Boolean schema
  if (el.is<bool>()) {
    node->boolean_schema = bool(el);
    return node;
  }

  if (!el.is<dom::object>()) {
    return node;
  }

  auto obj = dom::object(el);

  // $ref
  dom::element ref_el;
  if (obj["$ref"].get(ref_el) == SUCCESS) {
    std::string_view ref_sv;
    if (ref_el.get(ref_sv) == SUCCESS) {
      node->ref = std::string(ref_sv);
    }
  }

  // type
  dom::element type_el;
  if (obj["type"].get(type_el) == SUCCESS) {
    if (type_el.is<std::string_view>()) {
      std::string_view sv;
      type_el.get(sv);
      node->types.emplace_back(sv);
    } else if (type_el.is<dom::array>()) {
      for (auto t : dom::array(type_el)) {
        std::string_view sv;
        if (t.get(sv) == SUCCESS) {
          node->types.emplace_back(sv);
        }
      }
    }
  }

  // numeric constraints
  dom::element num_el;
  if (obj["minimum"].get(num_el) == SUCCESS) {
    double v;
    if (num_el.get(v) == SUCCESS) node->minimum = v;
  }
  if (obj["maximum"].get(num_el) == SUCCESS) {
    double v;
    if (num_el.get(v) == SUCCESS) node->maximum = v;
  }
  if (obj["exclusiveMinimum"].get(num_el) == SUCCESS) {
    double v;
    if (num_el.get(v) == SUCCESS) node->exclusive_minimum = v;
  }
  if (obj["exclusiveMaximum"].get(num_el) == SUCCESS) {
    double v;
    if (num_el.get(v) == SUCCESS) node->exclusive_maximum = v;
  }
  if (obj["multipleOf"].get(num_el) == SUCCESS) {
    double v;
    if (num_el.get(v) == SUCCESS) node->multiple_of = v;
  }

  // string constraints
  dom::element str_el;
  if (obj["minLength"].get(str_el) == SUCCESS) {
    uint64_t v;
    if (str_el.get(v) == SUCCESS) node->min_length = v;
  }
  if (obj["maxLength"].get(str_el) == SUCCESS) {
    uint64_t v;
    if (str_el.get(v) == SUCCESS) node->max_length = v;
  }
  if (obj["pattern"].get(str_el) == SUCCESS) {
    std::string_view sv;
    if (str_el.get(sv) == SUCCESS) {
      node->pattern = std::string(sv);
      try {
        node->compiled_pattern =
            std::make_shared<std::regex>(node->pattern.value());
      } catch (...) {
        // Invalid regex — leave compiled_pattern null
      }
    }
  }

  // array constraints
  if (obj["minItems"].get(str_el) == SUCCESS) {
    uint64_t v;
    if (str_el.get(v) == SUCCESS) node->min_items = v;
  }
  if (obj["maxItems"].get(str_el) == SUCCESS) {
    uint64_t v;
    if (str_el.get(v) == SUCCESS) node->max_items = v;
  }
  dom::element ui_el;
  if (obj["uniqueItems"].get(ui_el) == SUCCESS) {
    bool v;
    if (ui_el.get(v) == SUCCESS) node->unique_items = v;
  }
  // prefixItems (Draft 2020-12)
  dom::element pi_el;
  if (obj["prefixItems"].get(pi_el) == SUCCESS && pi_el.is<dom::array>()) {
    for (auto item : dom::array(pi_el)) {
      node->prefix_items.push_back(compile_node(item, ctx));
    }
  }

  dom::element items_el;
  if (obj["items"].get(items_el) == SUCCESS) {
    node->items_schema = compile_node(items_el, ctx);
  }

  // object constraints
  dom::element props_el;
  if (obj["properties"].get(props_el) == SUCCESS && props_el.is<dom::object>()) {
    for (auto [key, val] : dom::object(props_el)) {
      node->properties[std::string(key)] = compile_node(val, ctx);
    }
  }

  dom::element req_el;
  if (obj["required"].get(req_el) == SUCCESS && req_el.is<dom::array>()) {
    for (auto r : dom::array(req_el)) {
      std::string_view sv;
      if (r.get(sv) == SUCCESS) {
        node->required.emplace_back(sv);
      }
    }
  }

  dom::element ap_el;
  if (obj["additionalProperties"].get(ap_el) == SUCCESS) {
    if (ap_el.is<bool>()) {
      node->additional_properties_bool = bool(ap_el);
    } else {
      node->additional_properties_schema = compile_node(ap_el, ctx);
    }
  }

  if (obj["minProperties"].get(str_el) == SUCCESS) {
    uint64_t v;
    if (str_el.get(v) == SUCCESS) node->min_properties = v;
  }
  if (obj["maxProperties"].get(str_el) == SUCCESS) {
    uint64_t v;
    if (str_el.get(v) == SUCCESS) node->max_properties = v;
  }

  // patternProperties
  dom::element pp_el;
  if (obj["patternProperties"].get(pp_el) == SUCCESS &&
      pp_el.is<dom::object>()) {
    for (auto [key, val] : dom::object(pp_el)) {
      node->pattern_properties.emplace_back(std::string(key),
                                             compile_node(val, ctx));
    }
  }

  // format
  dom::element fmt_el;
  if (obj["format"].get(fmt_el) == SUCCESS) {
    std::string_view sv;
    if (fmt_el.get(sv) == SUCCESS) node->format = std::string(sv);
  }

  // $id (register in defs for potential resolution)
  dom::element id_el;
  if (obj["$id"].get(id_el) == SUCCESS) {
    std::string_view sv;
    if (id_el.get(sv) == SUCCESS) {
      ctx.defs[std::string(sv)] = node;
    }
  }

  // enum — pre-minify each value at compile time
  dom::element enum_el;
  if (obj["enum"].get(enum_el) == SUCCESS) {
    node->enum_values_raw = std::string(minify(enum_el));
    if (enum_el.is<dom::array>()) {
      for (auto e : dom::array(enum_el)) {
        node->enum_values_minified.push_back(std::string(minify(e)));
      }
    }
  }

  // const
  dom::element const_el;
  if (obj["const"].get(const_el) == SUCCESS) {
    node->const_value_raw = std::string(minify(const_el));
  }

  // composition
  dom::element comp_el;
  if (obj["allOf"].get(comp_el) == SUCCESS && comp_el.is<dom::array>()) {
    for (auto s : dom::array(comp_el)) {
      node->all_of.push_back(compile_node(s, ctx));
    }
  }
  if (obj["anyOf"].get(comp_el) == SUCCESS && comp_el.is<dom::array>()) {
    for (auto s : dom::array(comp_el)) {
      node->any_of.push_back(compile_node(s, ctx));
    }
  }
  if (obj["oneOf"].get(comp_el) == SUCCESS && comp_el.is<dom::array>()) {
    for (auto s : dom::array(comp_el)) {
      node->one_of.push_back(compile_node(s, ctx));
    }
  }
  dom::element not_el;
  if (obj["not"].get(not_el) == SUCCESS) {
    node->not_schema = compile_node(not_el, ctx);
  }

  // conditional
  dom::element if_el;
  if (obj["if"].get(if_el) == SUCCESS) {
    node->if_schema = compile_node(if_el, ctx);
  }
  dom::element then_el;
  if (obj["then"].get(then_el) == SUCCESS) {
    node->then_schema = compile_node(then_el, ctx);
  }
  dom::element else_el;
  if (obj["else"].get(else_el) == SUCCESS) {
    node->else_schema = compile_node(else_el, ctx);
  }

  // $defs / definitions
  dom::element defs_el;
  if (obj["$defs"].get(defs_el) == SUCCESS && defs_el.is<dom::object>()) {
    for (auto [key, val] : dom::object(defs_el)) {
      std::string def_path = "#/$defs/" + std::string(key);
      ctx.defs[def_path] = compile_node(val, ctx);
    }
  }
  if (obj["definitions"].get(defs_el) == SUCCESS &&
      defs_el.is<dom::object>()) {
    for (auto [key, val] : dom::object(defs_el)) {
      std::string def_path = "#/definitions/" + std::string(key);
      ctx.defs[def_path] = compile_node(val, ctx);
    }
  }

  return node;
}

// --- Validation ---

static void validate_node(const schema_node_ptr& node,
                           dom::element value,
                           const std::string& path,
                           const compiled_schema& ctx,
                           std::vector<validation_error>& errors,
                           bool all_errors = true);

// Macro for early termination
#define ATA_CHECK_EARLY() if (!all_errors && !errors.empty()) return

// Use string_view to avoid allocations in hot path
static std::string_view type_of_sv(dom::element el) {
  switch (el.type()) {
    case dom::element_type::STRING:    return "string";
    case dom::element_type::INT64:
    case dom::element_type::UINT64:    return "integer";
    case dom::element_type::DOUBLE:    return "number";
    case dom::element_type::BOOL:      return "boolean";
    case dom::element_type::NULL_VALUE:return "null";
    case dom::element_type::ARRAY:     return "array";
    case dom::element_type::OBJECT:    return "object";
  }
  return "unknown";
}

static std::string type_of(dom::element el) {
  return std::string(type_of_sv(el));
}

static bool type_matches(dom::element el, const std::string& type) {
  auto actual = type_of_sv(el);
  if (actual == type) return true;
  if (type == "number" && (actual == "integer" || actual == "number"))
    return true;
  return false;
}

static double to_double(dom::element el) {
  double v = 0;
  if (el.get(v) == SUCCESS) return v;
  int64_t i = 0;
  if (el.get(i) == SUCCESS) return static_cast<double>(i);
  uint64_t u = 0;
  if (el.get(u) == SUCCESS) return static_cast<double>(u);
  return 0;
}

// Count UTF-8 codepoints — branchless: count non-continuation bytes
static uint64_t utf8_length(std::string_view s) {
  uint64_t count = 0;
  for (size_t i = 0; i < s.size(); ++i) {
    // Continuation bytes are 10xxxxxx (0x80-0xBF)
    // Non-continuation bytes start codepoints
    count += ((static_cast<unsigned char>(s[i]) & 0xC0) != 0x80);
  }
  return count;
}

static void validate_node(const schema_node_ptr& node,
                           dom::element value,
                           const std::string& path,
                           const compiled_schema& ctx,
                           std::vector<validation_error>& errors,
                           bool all_errors) {
  if (!node) return;

  // Boolean schema
  if (node->boolean_schema.has_value()) {
    if (!node->boolean_schema.value()) {
      errors.push_back({error_code::type_mismatch, path,
                        "schema is false, no value is valid"});
    }
    return;
  }

  // $ref
  if (!node->ref.empty()) {
    // First check defs map
    auto it = ctx.defs.find(node->ref);
    if (it != ctx.defs.end()) {
      validate_node(it->second, value, path, ctx, errors, all_errors);
      return;
    }
    // Try JSON Pointer resolution from root (e.g., "#/properties/foo")
    if (node->ref.size() > 1 && node->ref[0] == '#' &&
        node->ref[1] == '/') {
      // Walk the schema tree following the pointer
      std::string pointer = node->ref.substr(2);
      schema_node_ptr current = ctx.root;
      bool resolved = true;
      size_t pos = 0;
      while (pos < pointer.size() && current) {
        size_t next = pointer.find('/', pos);
        std::string segment =
            pointer.substr(pos, next == std::string::npos ? next : next - pos);
        // Unescape JSON Pointer: ~1 -> /, ~0 -> ~
        std::string key;
        for (size_t i = 0; i < segment.size(); ++i) {
          if (segment[i] == '~' && i + 1 < segment.size()) {
            if (segment[i + 1] == '1') { key += '/'; ++i; }
            else if (segment[i + 1] == '0') { key += '~'; ++i; }
            else key += segment[i];
          } else {
            key += segment[i];
          }
        }
        // Navigate the compiled schema tree
        if (key == "properties" && !current->properties.empty()) {
          // Next segment is the property name
          pos = (next == std::string::npos) ? pointer.size() : next + 1;
          next = pointer.find('/', pos);
          std::string prop_name = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          auto pit = current->properties.find(prop_name);
          if (pit != current->properties.end()) {
            current = pit->second;
          } else {
            resolved = false; break;
          }
        } else if (key == "items" && current->items_schema) {
          current = current->items_schema;
        } else if (key == "$defs" || key == "definitions") {
          // Next segment is the def name — already in ctx.defs
          pos = (next == std::string::npos) ? pointer.size() : next + 1;
          next = pointer.find('/', pos);
          std::string def_name = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          std::string full_ref = "#/" + key + "/" + def_name;
          auto dit = ctx.defs.find(full_ref);
          if (dit != ctx.defs.end()) {
            current = dit->second;
          } else {
            resolved = false; break;
          }
        } else if (key == "allOf" || key == "anyOf" || key == "oneOf") {
          pos = (next == std::string::npos) ? pointer.size() : next + 1;
          next = pointer.find('/', pos);
          std::string idx_str = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          size_t idx = std::stoul(idx_str);
          auto& vec = (key == "allOf") ? current->all_of
                    : (key == "anyOf") ? current->any_of
                    : current->one_of;
          if (idx < vec.size()) {
            current = vec[idx];
          } else {
            resolved = false; break;
          }
        } else if (key == "not" && current->not_schema) {
          current = current->not_schema;
        } else if (key == "if" && current->if_schema) {
          current = current->if_schema;
        } else if (key == "then" && current->then_schema) {
          current = current->then_schema;
        } else if (key == "else" && current->else_schema) {
          current = current->else_schema;
        } else if (key == "additionalProperties" &&
                   current->additional_properties_schema) {
          current = current->additional_properties_schema;
        } else if (key == "prefixItems") {
          pos = (next == std::string::npos) ? pointer.size() : next + 1;
          next = pointer.find('/', pos);
          std::string idx_str = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          size_t idx = std::stoul(idx_str);
          if (idx < current->prefix_items.size()) {
            current = current->prefix_items[idx];
          } else {
            resolved = false; break;
          }
        } else {
          resolved = false; break;
        }
        pos = (next == std::string::npos) ? pointer.size() : next + 1;
      }
      if (resolved && current) {
        validate_node(current, value, path, ctx, errors, all_errors);
        return;
      }
    }
    // Self-reference: "#"
    if (node->ref == "#" && ctx.root) {
      validate_node(ctx.root, value, path, ctx, errors, all_errors);
      return;
    }
    errors.push_back({error_code::ref_not_found, path,
                      "cannot resolve $ref: " + node->ref});
    return;
  }

  // type
  if (!node->types.empty()) {
    bool match = false;
    for (const auto& t : node->types) {
      if (type_matches(value, t)) {
        match = true;
        break;
      }
    }
    if (!match) {
      std::string expected;
      for (size_t i = 0; i < node->types.size(); ++i) {
        if (i > 0) expected += ", ";
        expected += node->types[i];
      }
      errors.push_back({error_code::type_mismatch, path,
                        "expected type " + expected + ", got " + type_of(value)});
      ATA_CHECK_EARLY();
    }
  }

  // enum — use pre-minified values (no re-parsing)
  if (!node->enum_values_minified.empty()) {
    std::string val_str = std::string(minify(value));
    bool found = false;
    for (const auto& ev : node->enum_values_minified) {
      if (ev == val_str) {
        found = true;
        break;
      }
    }
    if (!found) {
      errors.push_back({error_code::enum_mismatch, path,
                        "value not in enum"});
    }
  }

  // const
  if (node->const_value_raw.has_value()) {
    std::string val_str = std::string(minify(value));
    if (val_str != node->const_value_raw.value()) {
      errors.push_back({error_code::const_mismatch, path,
                        "value does not match const"});
      ATA_CHECK_EARLY();
    }
  }

  ATA_CHECK_EARLY();
  // Numeric validations
  auto actual_type = type_of(value);
  if (actual_type == "integer" || actual_type == "number") {
    double v = to_double(value);
    if (node->minimum.has_value() && v < node->minimum.value()) {
      errors.push_back({error_code::minimum_violation, path,
                        "value " + std::to_string(v) + " < minimum " +
                            std::to_string(node->minimum.value())});
    }
    if (node->maximum.has_value() && v > node->maximum.value()) {
      errors.push_back({error_code::maximum_violation, path,
                        "value " + std::to_string(v) + " > maximum " +
                            std::to_string(node->maximum.value())});
    }
    if (node->exclusive_minimum.has_value() &&
        v <= node->exclusive_minimum.value()) {
      errors.push_back({error_code::exclusive_minimum_violation, path,
                        "value must be > " +
                            std::to_string(node->exclusive_minimum.value())});
    }
    if (node->exclusive_maximum.has_value() &&
        v >= node->exclusive_maximum.value()) {
      errors.push_back({error_code::exclusive_maximum_violation, path,
                        "value must be < " +
                            std::to_string(node->exclusive_maximum.value())});
    }
    if (node->multiple_of.has_value()) {
      double divisor = node->multiple_of.value();
      double rem = std::fmod(v, divisor);
      // Use relative tolerance for floating point comparison
      if (std::abs(rem) > 1e-8 && std::abs(rem - divisor) > 1e-8) {
        errors.push_back({error_code::multiple_of_violation, path,
                          "value not a multiple of " +
                              std::to_string(node->multiple_of.value())});
      }
    }
  }

  // String validations
  if (actual_type == "string") {
    std::string_view sv;
    value.get(sv);
    uint64_t len = utf8_length(sv);

    if (node->min_length.has_value() && len < node->min_length.value()) {
      errors.push_back({error_code::min_length_violation, path,
                        "string length " + std::to_string(len) +
                            " < minLength " +
                            std::to_string(node->min_length.value())});
    }
    if (node->max_length.has_value() && len > node->max_length.value()) {
      errors.push_back({error_code::max_length_violation, path,
                        "string length " + std::to_string(len) +
                            " > maxLength " +
                            std::to_string(node->max_length.value())});
    }
    if (node->compiled_pattern) {
      if (!std::regex_search(sv.begin(), sv.end(), *node->compiled_pattern)) {
        errors.push_back({error_code::pattern_mismatch, path,
                          "string does not match pattern: " +
                              node->pattern.value()});
      }
    }

    if (node->format.has_value()) {
      if (!check_format(sv, node->format.value())) {
        errors.push_back({error_code::format_mismatch, path,
                          "string does not match format: " +
                              node->format.value()});
      }
    }
  }

  // Array validations
  if (actual_type == "array" && value.is<dom::array>()) {
    auto arr = dom::array(value);
    uint64_t arr_size = 0;
    for ([[maybe_unused]] auto _ : arr) ++arr_size;

    if (node->min_items.has_value() && arr_size < node->min_items.value()) {
      errors.push_back({error_code::min_items_violation, path,
                        "array has " + std::to_string(arr_size) +
                            " items, minimum " +
                            std::to_string(node->min_items.value())});
    }
    if (node->max_items.has_value() && arr_size > node->max_items.value()) {
      errors.push_back({error_code::max_items_violation, path,
                        "array has " + std::to_string(arr_size) +
                            " items, maximum " +
                            std::to_string(node->max_items.value())});
    }

    if (node->unique_items) {
      std::set<std::string> seen;
      bool has_dup = false;
      for (auto item : arr) {
        auto s = std::string(minify(item));
        if (!seen.insert(s).second) {
          has_dup = true;
          break;
        }
      }
      if (has_dup) {
        errors.push_back({error_code::unique_items_violation, path,
                          "array contains duplicate items"});
      }
    }

    // prefixItems + items (Draft 2020-12 semantics)
    {
      uint64_t idx = 0;
      for (auto item : arr) {
        if (idx < node->prefix_items.size()) {
          validate_node(node->prefix_items[idx], item,
                        path + "/" + std::to_string(idx), ctx, errors);
        } else if (node->items_schema) {
          validate_node(node->items_schema, item,
                        path + "/" + std::to_string(idx), ctx, errors);
        }
        ++idx;
      }
    }
  }

  // Object validations
  if (actual_type == "object" && value.is<dom::object>()) {
    auto obj = dom::object(value);
    uint64_t prop_count = 0;
    for ([[maybe_unused]] auto _ : obj) ++prop_count;

    if (node->min_properties.has_value() &&
        prop_count < node->min_properties.value()) {
      errors.push_back({error_code::min_properties_violation, path,
                        "object has " + std::to_string(prop_count) +
                            " properties, minimum " +
                            std::to_string(node->min_properties.value())});
    }
    if (node->max_properties.has_value() &&
        prop_count > node->max_properties.value()) {
      errors.push_back({error_code::max_properties_violation, path,
                        "object has " + std::to_string(prop_count) +
                            " properties, maximum " +
                            std::to_string(node->max_properties.value())});
    }

    // required
    for (const auto& req : node->required) {
      dom::element dummy;
      if (obj[req].get(dummy) != SUCCESS) {
        errors.push_back({error_code::required_property_missing, path,
                          "missing required property: " + req});
      }
    }

    // properties + patternProperties + additionalProperties
    for (auto [key, val] : obj) {
      std::string key_str(key);
      bool matched = false;

      // Check properties
      auto it = node->properties.find(key_str);
      if (it != node->properties.end()) {
        validate_node(it->second, val, path + "/" + key_str, ctx, errors, all_errors);
        matched = true;
      }

      // Check patternProperties
      for (const auto& [pat, pat_schema] : node->pattern_properties) {
        try {
          std::regex re(pat);
          if (std::regex_search(key_str, re)) {
            validate_node(pat_schema, val, path + "/" + key_str, ctx, errors, all_errors);
            matched = true;
          }
        } catch (...) {
        }
      }

      // additionalProperties (only if not matched by properties or patternProperties)
      if (!matched) {
        if (node->additional_properties_bool.has_value() &&
            !node->additional_properties_bool.value()) {
          errors.push_back(
              {error_code::additional_property_not_allowed, path,
               "additional property not allowed: " + key_str});
        } else if (node->additional_properties_schema) {
          validate_node(node->additional_properties_schema, val,
                        path + "/" + key_str, ctx, errors);
        }
      }
    }
  }

  // allOf
  if (!node->all_of.empty()) {
    for (const auto& sub : node->all_of) {
      std::vector<validation_error> sub_errors;
      validate_node(sub, value, path, ctx, sub_errors, all_errors);
      if (!sub_errors.empty()) {
        errors.push_back({error_code::all_of_failed, path,
                          "allOf subschema failed"});
        errors.insert(errors.end(), sub_errors.begin(), sub_errors.end());
      }
    }
  }

  // anyOf
  if (!node->any_of.empty()) {
    bool any_valid = false;
    for (const auto& sub : node->any_of) {
      std::vector<validation_error> sub_errors;
      validate_node(sub, value, path, ctx, sub_errors, all_errors);
      if (sub_errors.empty()) {
        any_valid = true;
        break;
      }
    }
    if (!any_valid) {
      errors.push_back({error_code::any_of_failed, path,
                        "no anyOf subschema matched"});
    }
  }

  // oneOf
  if (!node->one_of.empty()) {
    int match_count = 0;
    for (const auto& sub : node->one_of) {
      std::vector<validation_error> sub_errors;
      validate_node(sub, value, path, ctx, sub_errors, all_errors);
      if (sub_errors.empty()) ++match_count;
    }
    if (match_count != 1) {
      errors.push_back({error_code::one_of_failed, path,
                        "expected exactly one oneOf match, got " +
                            std::to_string(match_count)});
    }
  }

  // not
  if (node->not_schema) {
    std::vector<validation_error> sub_errors;
    validate_node(node->not_schema, value, path, ctx, sub_errors, all_errors);
    if (sub_errors.empty()) {
      errors.push_back({error_code::not_failed, path,
                        "value should not match 'not' schema"});
    }
  }

  // if/then/else
  if (node->if_schema) {
    std::vector<validation_error> if_errors;
    validate_node(node->if_schema, value, path, ctx, if_errors, all_errors);
    if (if_errors.empty()) {
      // if passed → validate then
      if (node->then_schema) {
        validate_node(node->then_schema, value, path, ctx, errors, all_errors);
      }
    } else {
      // if failed → validate else
      if (node->else_schema) {
        validate_node(node->else_schema, value, path, ctx, errors, all_errors);
      }
    }
  }
}

schema_ref compile(std::string_view schema_json) {
  auto ctx = std::make_shared<compiled_schema>();
  ctx->raw_schema = std::string(schema_json);

  dom::element doc;
  auto result = ctx->parser.parse(ctx->raw_schema);
  if (result.error()) {
    return schema_ref{nullptr};
  }
  doc = result.value();

  ctx->root = compile_node(doc, *ctx);

  schema_ref ref;
  ref.impl = ctx;
  return ref;
}

validation_result validate(const schema_ref& schema, std::string_view json,
                           const validate_options& opts) {
  if (!schema.impl || !schema.impl->root) {
    return {false, {{error_code::invalid_schema, "", "schema not compiled"}}};
  }

  auto padded = simdjson::padded_string(json);
  auto result = schema.impl->doc_parser.parse(padded);
  if (result.error()) {
    return {false, {{error_code::invalid_json, "", "invalid JSON document"}}};
  }

  std::vector<validation_error> errors;
  validate_node(schema.impl->root, result.value(), "", *schema.impl, errors,
                opts.all_errors);

  return {errors.empty(), std::move(errors)};
}

validation_result validate(std::string_view schema_json,
                           std::string_view json,
                           const validate_options& opts) {
  auto s = compile(schema_json);
  if (!s) {
    return {false, {{error_code::invalid_schema, "", "failed to compile schema"}}};
  }
  return validate(s, json, opts);
}

}  // namespace ata
