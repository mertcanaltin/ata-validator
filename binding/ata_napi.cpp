#include <napi.h>
#include <node_api.h>

#include <cmath>
#include <thread>
#include <future>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <queue>
#include <atomic>
#include <re2/re2.h>
#include <set>
#include <string>
#include <vector>

#include "ata.h"

// ============================================================================
// V8 Direct Object Traversal Engine
// Validates Napi::Value directly without JSON.stringify + simdjson parse
// ============================================================================

// Forward declare - we need access to compiled schema internals
// We include the schema_node definition here to avoid modifying ata.h
struct schema_node;
using schema_node_ptr = std::shared_ptr<schema_node>;

// MUST match layout in src/ata.cpp exactly (reinterpret_cast)
struct schema_node {
  uint8_t type_mask = 0;

  std::optional<double> minimum;
  std::optional<double> maximum;
  std::optional<double> exclusive_minimum;
  std::optional<double> exclusive_maximum;
  std::optional<double> multiple_of;

  std::optional<uint64_t> min_length;
  std::optional<uint64_t> max_length;
  std::optional<std::string> pattern;
  std::shared_ptr<re2::RE2> compiled_pattern;

  std::optional<uint64_t> min_items;
  std::optional<uint64_t> max_items;
  bool unique_items = false;
  schema_node_ptr items_schema;
  std::vector<schema_node_ptr> prefix_items;
  schema_node_ptr contains_schema;
  std::optional<uint64_t> min_contains;
  std::optional<uint64_t> max_contains;

  std::unordered_map<std::string, schema_node_ptr> properties;
  std::vector<std::string> required;
  std::optional<bool> additional_properties_bool;
  schema_node_ptr additional_properties_schema;
  std::optional<uint64_t> min_properties;
  std::optional<uint64_t> max_properties;
  schema_node_ptr property_names_schema;
  std::unordered_map<std::string, std::vector<std::string>> dependent_required;
  std::unordered_map<std::string, schema_node_ptr> dependent_schemas;

  struct pattern_prop {
    std::string pattern;
    schema_node_ptr schema;
    std::shared_ptr<re2::RE2> compiled;
  };
  std::vector<pattern_prop> pattern_properties;

  std::vector<std::string> enum_values_minified;
  std::optional<std::string> const_value_raw;

  std::optional<std::string> format;
  uint8_t format_id = 255;

  std::vector<schema_node_ptr> all_of;
  std::vector<schema_node_ptr> any_of;
  std::vector<schema_node_ptr> one_of;
  schema_node_ptr not_schema;

  schema_node_ptr if_schema;
  schema_node_ptr then_schema;
  schema_node_ptr else_schema;

  std::string ref;

  std::unordered_map<std::string, schema_node_ptr> defs;

  std::optional<bool> boolean_schema;
};

struct compiled_schema_internal {
  schema_node_ptr root;
  std::unordered_map<std::string, schema_node_ptr> defs;
};

// --- Fast format validators (no regex) ---

static bool nb_is_digit(char c) { return c >= '0' && c <= '9'; }
static bool nb_is_alpha(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
static bool nb_is_alnum(char c) { return nb_is_alpha(c) || nb_is_digit(c); }
static bool nb_is_hex(char c) {
  return nb_is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static bool napi_check_format(const std::string& sv, const std::string& fmt) {
  if (fmt == "email") {
    auto at = sv.find('@');
    if (at == std::string::npos || at == 0 || at == sv.size() - 1) return false;
    auto dot = sv.find('.', at + 1);
    return dot != std::string::npos && dot != at + 1 && dot != sv.size() - 1 &&
           (sv.size() - dot - 1) >= 2;
  }
  if (fmt == "date") {
    return sv.size() == 10 && nb_is_digit(sv[0]) && nb_is_digit(sv[1]) &&
           nb_is_digit(sv[2]) && nb_is_digit(sv[3]) && sv[4] == '-' &&
           nb_is_digit(sv[5]) && nb_is_digit(sv[6]) && sv[7] == '-' &&
           nb_is_digit(sv[8]) && nb_is_digit(sv[9]);
  }
  if (fmt == "time") {
    if (sv.size() < 8) return false;
    return nb_is_digit(sv[0]) && nb_is_digit(sv[1]) && sv[2] == ':' &&
           nb_is_digit(sv[3]) && nb_is_digit(sv[4]) && sv[5] == ':' &&
           nb_is_digit(sv[6]) && nb_is_digit(sv[7]);
  }
  if (fmt == "date-time") {
    if (sv.size() < 19) return false;
    if (!napi_check_format(sv.substr(0, 10), "date")) return false;
    if (sv[10] != 'T' && sv[10] != 't' && sv[10] != ' ') return false;
    return napi_check_format(sv.substr(11), "time");
  }
  if (fmt == "ipv4") {
    int parts = 0, val = 0, digits = 0;
    for (size_t i = 0; i <= sv.size(); ++i) {
      if (i == sv.size() || sv[i] == '.') {
        if (digits == 0 || val > 255) return false;
        ++parts; val = 0; digits = 0;
      } else if (nb_is_digit(sv[i])) {
        val = val * 10 + (sv[i] - '0'); ++digits;
        if (digits > 3) return false;
      } else {
        return false;
      }
    }
    return parts == 4;
  }
  if (fmt == "ipv6") return sv.find(':') != std::string::npos;
  if (fmt == "uri" || fmt == "uri-reference") {
    if (sv.size() < 3 || !nb_is_alpha(sv[0])) return false;
    size_t i = 1;
    while (i < sv.size() && (nb_is_alnum(sv[i]) || sv[i] == '+' || sv[i] == '-' || sv[i] == '.')) ++i;
    return i < sv.size() && sv[i] == ':' && i + 1 < sv.size();
  }
  if (fmt == "uuid") {
    if (sv.size() != 36) return false;
    for (size_t i = 0; i < 36; ++i) {
      if (i == 8 || i == 13 || i == 18 || i == 23) {
        if (sv[i] != '-') return false;
      } else {
        if (!nb_is_hex(sv[i])) return false;
      }
    }
    return true;
  }
  if (fmt == "hostname") {
    if (sv.empty() || sv.size() > 253) return false;
    size_t label_len = 0;
    for (size_t i = 0; i < sv.size(); ++i) {
      if (sv[i] == '.') { if (label_len == 0) return false; label_len = 0; }
      else if (nb_is_alnum(sv[i]) || sv[i] == '-') { ++label_len; if (label_len > 63) return false; }
      else return false;
    }
    return label_len > 0;
  }
  return true;
}

// --- V8 Direct Validator ---

static std::string napi_type_of(Napi::Value val) {
  if (val.IsNull()) return "null";
  if (val.IsBoolean()) return "boolean";
  if (val.IsNumber()) {
    double d = val.As<Napi::Number>().DoubleValue();
    if (std::isfinite(d) && d == std::floor(d) &&
        std::abs(d) <= 9007199254740991.0) {
      return "integer";
    }
    return "number";
  }
  if (val.IsString()) return "string";
  if (val.IsArray()) return "array";
  if (val.IsObject()) return "object";
  return "unknown";
}

static bool napi_type_matches(Napi::Value val, const std::string& type) {
  auto actual = napi_type_of(val);
  if (actual == type) return true;
  if (type == "number" && (actual == "integer" || actual == "number"))
    return true;
  return false;
}

static uint64_t utf8_codepoint_length(const std::string& s) {
  uint64_t len = 0;
  for (size_t i = 0; i < s.size();) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c < 0x80) i += 1;
    else if ((c >> 5) == 0x06) i += 2;
    else if ((c >> 4) == 0x0E) i += 3;
    else if ((c >> 3) == 0x1E) i += 4;
    else i += 1;
    ++len;
  }
  return len;
}

// Serialize a Napi::Value to a minified JSON string (for enum/const comparison)
// Canonical JSON: sort object keys for semantic equality comparison
static std::string napi_canonical_json(Napi::Env env, Napi::Value val) {
  if (val.IsNull() || val.IsUndefined()) return "null";
  if (val.IsBoolean()) return val.As<Napi::Boolean>().Value() ? "true" : "false";
  if (val.IsNumber()) {
    double d = val.As<Napi::Number>().DoubleValue();
    if (d == static_cast<int64_t>(d) && std::abs(d) <= 9007199254740991.0) {
      return std::to_string(static_cast<int64_t>(d));
    }
    auto json = env.Global().Get("JSON").As<Napi::Object>();
    auto stringify = json.Get("stringify").As<Napi::Function>();
    auto r = stringify.Call(json, {val});
    return r.IsString() ? r.As<Napi::String>().Utf8Value() : "null";
  }
  if (val.IsString()) {
    // JSON-encode the string
    auto json = env.Global().Get("JSON").As<Napi::Object>();
    auto stringify = json.Get("stringify").As<Napi::Function>();
    auto r = stringify.Call(json, {val});
    return r.IsString() ? r.As<Napi::String>().Utf8Value() : "null";
  }
  if (val.IsArray()) {
    auto arr = val.As<Napi::Array>();
    std::string r = "[";
    for (uint32_t i = 0; i < arr.Length(); ++i) {
      if (i) r += ',';
      r += napi_canonical_json(env, arr.Get(i));
    }
    r += ']';
    return r;
  }
  if (val.IsObject()) {
    auto obj = val.As<Napi::Object>();
    auto keys = obj.GetPropertyNames();
    std::vector<std::string> sorted_keys;
    for (uint32_t i = 0; i < keys.Length(); ++i) {
      sorted_keys.push_back(keys.Get(i).As<Napi::String>().Utf8Value());
    }
    std::sort(sorted_keys.begin(), sorted_keys.end());
    std::string r = "{";
    for (size_t i = 0; i < sorted_keys.size(); ++i) {
      if (i) r += ',';
      // JSON-encode the key
      auto json = env.Global().Get("JSON").As<Napi::Object>();
      auto stringify = json.Get("stringify").As<Napi::Function>();
      auto k = stringify.Call(json, {Napi::String::New(env, sorted_keys[i])});
      r += k.As<Napi::String>().Utf8Value();
      r += ':';
      r += napi_canonical_json(env, obj.Get(sorted_keys[i]));
    }
    r += '}';
    return r;
  }
  return "null";
}

static std::string napi_to_json(Napi::Env env, Napi::Value val) {
  return napi_canonical_json(env, val);
}

static void validate_napi(const schema_node_ptr& node,
                           Napi::Value value,
                           Napi::Env env,
                           const std::string& path,
                           const compiled_schema_internal& ctx,
                           std::vector<ata::validation_error>& errors);

static void validate_napi(const schema_node_ptr& node,
                           Napi::Value value,
                           Napi::Env env,
                           const std::string& path,
                           const compiled_schema_internal& ctx,
                           std::vector<ata::validation_error>& errors) {
  if (!node) return;

  // Boolean schema
  if (node->boolean_schema.has_value()) {
    if (!node->boolean_schema.value()) {
      errors.push_back({ata::error_code::type_mismatch, path,
                        "schema is false, no value is valid"});
    }
    return;
  }

  // $ref — Draft 2020-12: $ref is not a short-circuit, sibling keywords still apply
  bool ref_resolved = false;
  if (!node->ref.empty()) {
    auto it = ctx.defs.find(node->ref);
    if (it != ctx.defs.end()) {
      validate_napi(it->second, value, env, path, ctx, errors);
      ref_resolved = true;
    }
    if (!ref_resolved && node->ref.size() > 1 && node->ref[0] == '#' &&
        node->ref[1] == '/') {
      // Decode JSON Pointer segments
      auto decode_seg = [](const std::string& seg) -> std::string {
        std::string pct;
        for (size_t i = 0; i < seg.size(); ++i) {
          if (seg[i] == '%' && i + 2 < seg.size()) {
            auto hex = [](char c) -> int {
              if (c >= '0' && c <= '9') return c - '0';
              if (c >= 'a' && c <= 'f') return 10 + c - 'a';
              if (c >= 'A' && c <= 'F') return 10 + c - 'A';
              return -1;
            };
            int hv = hex(seg[i+1]), lv = hex(seg[i+2]);
            if (hv >= 0 && lv >= 0) { pct += static_cast<char>(hv * 16 + lv); i += 2; }
            else pct += seg[i];
          } else pct += seg[i];
        }
        std::string out;
        for (size_t i = 0; i < pct.size(); ++i) {
          if (pct[i] == '~' && i + 1 < pct.size()) {
            if (pct[i+1] == '1') { out += '/'; ++i; }
            else if (pct[i+1] == '0') { out += '~'; ++i; }
            else out += pct[i];
          } else out += pct[i];
        }
        return out;
      };
      std::string pointer = node->ref.substr(2);
      std::vector<std::string> segments;
      size_t spos = 0;
      while (spos < pointer.size()) {
        size_t snext = pointer.find('/', spos);
        segments.push_back(decode_seg(
            pointer.substr(spos, snext == std::string::npos ? snext : snext - spos)));
        spos = (snext == std::string::npos) ? pointer.size() : snext + 1;
      }
      schema_node_ptr current = ctx.root;
      bool resolved = true;
      for (size_t si = 0; si < segments.size() && current; ++si) {
        const auto& key = segments[si];
        if (key == "properties" && si + 1 < segments.size()) {
          auto pit = current->properties.find(segments[++si]);
          if (pit != current->properties.end()) current = pit->second;
          else { resolved = false; break; }
        } else if (key == "items" && current->items_schema) {
          current = current->items_schema;
        } else if (key == "$defs" || key == "definitions") {
          if (si + 1 < segments.size()) {
            const auto& def_name = segments[++si];
            auto dit = current->defs.find(def_name);
            if (dit != current->defs.end()) current = dit->second;
            else {
              auto cit = ctx.defs.find("#/" + key + "/" + def_name);
              if (cit != ctx.defs.end()) current = cit->second;
              else { resolved = false; break; }
            }
          } else { resolved = false; break; }
        } else if (key == "allOf" || key == "anyOf" || key == "oneOf") {
          if (si + 1 < segments.size()) {
            size_t idx = std::stoul(segments[++si]);
            auto& vec = (key == "allOf") ? current->all_of
                      : (key == "anyOf") ? current->any_of : current->one_of;
            if (idx < vec.size()) current = vec[idx];
            else { resolved = false; break; }
          } else { resolved = false; break; }
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
          if (si + 1 < segments.size()) {
            size_t idx = std::stoul(segments[++si]);
            if (idx < current->prefix_items.size()) current = current->prefix_items[idx];
            else { resolved = false; break; }
          } else { resolved = false; break; }
        } else { resolved = false; break; }
      }
      if (resolved && current) {
        validate_napi(current, value, env, path, ctx, errors);
        ref_resolved = true;
      }
    }
    if (!ref_resolved && node->ref == "#" && ctx.root) {
      validate_napi(ctx.root, value, env, path, ctx, errors);
      ref_resolved = true;
    }
    if (!ref_resolved) {
      errors.push_back({ata::error_code::ref_not_found, path,
                        "cannot resolve $ref: " + node->ref});
    }
  }

  auto actual_type = napi_type_of(value);

  // type — uses bitmask matching ata.cpp json_type enum order:
  //   0=string, 1=number, 2=integer, 3=boolean, 4=null_value, 5=object, 6=array
  if (node->type_mask) {
    uint8_t val_bits = 0;
    if (actual_type == "string")       val_bits = 1u << 0;
    else if (actual_type == "number")  val_bits = 1u << 1;
    else if (actual_type == "integer") val_bits = (1u << 2) | (1u << 1); // integer matches number
    else if (actual_type == "boolean") val_bits = 1u << 3;
    else if (actual_type == "null")    val_bits = 1u << 4;
    else if (actual_type == "object")  val_bits = 1u << 5;
    else if (actual_type == "array")   val_bits = 1u << 6;
    if (!(val_bits & node->type_mask)) {
      static const char* type_names[] = {"string","number","integer","boolean","null","object","array"};
      std::string expected;
      for (int b = 0; b < 7; ++b) {
        if (node->type_mask & (1u << b)) {
          if (!expected.empty()) expected += ", ";
          expected += type_names[b];
        }
      }
      errors.push_back({ata::error_code::type_mismatch, path,
                        "expected type " + expected + ", got " + actual_type});
    }
  }

  // enum — compare against pre-minified canonical values
  if (!node->enum_values_minified.empty()) {
    std::string val_json = napi_to_json(env, value);
    bool found = false;
    for (const auto& ev : node->enum_values_minified) {
      if (ev == val_json) {
        found = true;
        break;
      }
    }
    if (!found) {
      errors.push_back({ata::error_code::enum_mismatch, path,
                        "value not in enum"});
    }
  }

  // const
  if (node->const_value_raw.has_value()) {
    std::string val_json = napi_to_json(env, value);
    if (val_json != node->const_value_raw.value()) {
      errors.push_back({ata::error_code::const_mismatch, path,
                        "value does not match const"});
    }
  }

  // Numeric validations
  if (actual_type == "integer" || actual_type == "number") {
    double v = value.As<Napi::Number>().DoubleValue();
    if (node->minimum.has_value() && v < node->minimum.value()) {
      errors.push_back({ata::error_code::minimum_violation, path,
                        "value " + std::to_string(v) + " < minimum " +
                            std::to_string(node->minimum.value())});
    }
    if (node->maximum.has_value() && v > node->maximum.value()) {
      errors.push_back({ata::error_code::maximum_violation, path,
                        "value " + std::to_string(v) + " > maximum " +
                            std::to_string(node->maximum.value())});
    }
    if (node->exclusive_minimum.has_value() &&
        v <= node->exclusive_minimum.value()) {
      errors.push_back({ata::error_code::exclusive_minimum_violation, path,
                        "value must be > " +
                            std::to_string(node->exclusive_minimum.value())});
    }
    if (node->exclusive_maximum.has_value() &&
        v >= node->exclusive_maximum.value()) {
      errors.push_back({ata::error_code::exclusive_maximum_violation, path,
                        "value must be < " +
                            std::to_string(node->exclusive_maximum.value())});
    }
    if (node->multiple_of.has_value()) {
      double divisor = node->multiple_of.value();
      double rem = std::fmod(v, divisor);
      if (std::abs(rem) > 1e-8 && std::abs(rem - divisor) > 1e-8) {
        errors.push_back({ata::error_code::multiple_of_violation, path,
                          "value not a multiple of " +
                              std::to_string(node->multiple_of.value())});
      }
    }
  }

  // String validations
  if (actual_type == "string") {
    std::string sv = value.As<Napi::String>().Utf8Value();
    uint64_t len = utf8_codepoint_length(sv);

    if (node->min_length.has_value() && len < node->min_length.value()) {
      errors.push_back({ata::error_code::min_length_violation, path,
                        "string length " + std::to_string(len) +
                            " < minLength " +
                            std::to_string(node->min_length.value())});
    }
    if (node->max_length.has_value() && len > node->max_length.value()) {
      errors.push_back({ata::error_code::max_length_violation, path,
                        "string length " + std::to_string(len) +
                            " > maxLength " +
                            std::to_string(node->max_length.value())});
    }
    if (node->compiled_pattern) {
      if (!re2::RE2::PartialMatch(sv, *node->compiled_pattern)) {
        errors.push_back({ata::error_code::pattern_mismatch, path,
                          "string does not match pattern: " +
                              node->pattern.value()});
      }
    }
    if (node->format.has_value()) {
      const auto& fmt = node->format.value();
      bool format_ok = napi_check_format(sv, fmt);
      if (!format_ok) {
        errors.push_back({ata::error_code::format_mismatch, path,
                          "string does not match format: " + fmt});
      }
    }
  }

  // Array validations
  if (actual_type == "array" && value.IsArray()) {
    auto arr = value.As<Napi::Array>();
    uint32_t arr_size = arr.Length();

    if (node->min_items.has_value() && arr_size < node->min_items.value()) {
      errors.push_back({ata::error_code::min_items_violation, path,
                        "array has " + std::to_string(arr_size) +
                            " items, minimum " +
                            std::to_string(node->min_items.value())});
    }
    if (node->max_items.has_value() && arr_size > node->max_items.value()) {
      errors.push_back({ata::error_code::max_items_violation, path,
                        "array has " + std::to_string(arr_size) +
                            " items, maximum " +
                            std::to_string(node->max_items.value())});
    }

    if (node->unique_items) {
      std::set<std::string> seen;
      bool has_dup = false;
      for (uint32_t i = 0; i < arr_size; ++i) {
        auto s = napi_to_json(env, arr.Get(i));
        if (!seen.insert(s).second) {
          has_dup = true;
          break;
        }
      }
      if (has_dup) {
        errors.push_back({ata::error_code::unique_items_violation, path,
                          "array contains duplicate items"});
      }
    }

    // prefixItems + items (Draft 2020-12 semantics)
    for (uint32_t i = 0; i < arr_size; ++i) {
      if (i < node->prefix_items.size()) {
        validate_napi(node->prefix_items[i], arr.Get(i), env,
                      path + "/" + std::to_string(i), ctx, errors);
      } else if (node->items_schema) {
        validate_napi(node->items_schema, arr.Get(i), env,
                      path + "/" + std::to_string(i), ctx, errors);
      }
    }

    // contains / minContains / maxContains
    if (node->contains_schema) {
      uint64_t match_count = 0;
      for (uint32_t i = 0; i < arr_size; ++i) {
        std::vector<ata::validation_error> tmp;
        validate_napi(node->contains_schema, arr.Get(i), env, path, ctx, tmp);
        if (tmp.empty()) ++match_count;
      }
      uint64_t min_c = node->min_contains.value_or(1);
      uint64_t max_c = node->max_contains.value_or(arr_size);
      if (match_count < min_c) {
        errors.push_back({ata::error_code::min_items_violation, path,
                          "contains: " + std::to_string(match_count) +
                              " matches, minimum " + std::to_string(min_c)});
      }
      if (match_count > max_c) {
        errors.push_back({ata::error_code::max_items_violation, path,
                          "contains: " + std::to_string(match_count) +
                              " matches, maximum " + std::to_string(max_c)});
      }
    }
  }

  // Object validations
  if (actual_type == "object" && value.IsObject() && !value.IsArray()) {
    auto obj = value.As<Napi::Object>();
    auto keys = obj.GetPropertyNames();
    uint32_t prop_count = keys.Length();

    if (node->min_properties.has_value() &&
        prop_count < node->min_properties.value()) {
      errors.push_back({ata::error_code::min_properties_violation, path,
                        "object has " + std::to_string(prop_count) +
                            " properties, minimum " +
                            std::to_string(node->min_properties.value())});
    }
    if (node->max_properties.has_value() &&
        prop_count > node->max_properties.value()) {
      errors.push_back({ata::error_code::max_properties_violation, path,
                        "object has " + std::to_string(prop_count) +
                            " properties, maximum " +
                            std::to_string(node->max_properties.value())});
    }

    // required — use HasOwnProperty to avoid prototype pollution
    for (const auto& req : node->required) {
      bool has = obj.HasOwnProperty(req);
      if (!has) {
        errors.push_back({ata::error_code::required_property_missing, path,
                          "missing required property: " + req});
      }
    }

    // properties + patternProperties + additionalProperties
    for (uint32_t i = 0; i < prop_count; ++i) {
      std::string key_str = keys.Get(i).As<Napi::String>().Utf8Value();
      Napi::Value val = obj.Get(key_str);
      bool matched = false;

      auto it = node->properties.find(key_str);
      if (it != node->properties.end()) {
        validate_napi(it->second, val, env, path + "/" + key_str, ctx, errors);
        matched = true;
      }

      for (const auto& pp : node->pattern_properties) {
        if (pp.compiled && re2::RE2::PartialMatch(key_str, *pp.compiled)) {
          validate_napi(pp.schema, val, env, path + "/" + key_str, ctx,
                        errors);
          matched = true;
        }
      }

      if (!matched) {
        if (node->additional_properties_bool.has_value() &&
            !node->additional_properties_bool.value()) {
          errors.push_back(
              {ata::error_code::additional_property_not_allowed, path,
               "additional property not allowed: " + key_str});
        } else if (node->additional_properties_schema) {
          validate_napi(node->additional_properties_schema, val, env,
                        path + "/" + key_str, ctx, errors);
        }
      }
    }

    // propertyNames
    if (node->property_names_schema) {
      for (uint32_t i = 0; i < prop_count; ++i) {
        Napi::Value key_val = keys.Get(i);
        validate_napi(node->property_names_schema, key_val, env, path, ctx,
                      errors);
      }
    }

    // dependentRequired
    for (const auto& [prop, deps] : node->dependent_required) {
      if (obj.HasOwnProperty(prop)) {
        for (const auto& dep : deps) {
          if (!obj.HasOwnProperty(dep)) {
            errors.push_back({ata::error_code::required_property_missing, path,
                              "property '" + prop + "' requires '" + dep +
                                  "' to be present"});
          }
        }
      }
    }

    // dependentSchemas
    for (const auto& [prop, schema] : node->dependent_schemas) {
      if (obj.HasOwnProperty(prop)) {
        validate_napi(schema, value, env, path, ctx, errors);
      }
    }
  }

  // allOf
  if (!node->all_of.empty()) {
    for (const auto& sub : node->all_of) {
      std::vector<ata::validation_error> sub_errors;
      validate_napi(sub, value, env, path, ctx, sub_errors);
      if (!sub_errors.empty()) {
        errors.push_back({ata::error_code::all_of_failed, path,
                          "allOf subschema failed"});
        errors.insert(errors.end(), sub_errors.begin(), sub_errors.end());
      }
    }
  }

  // anyOf
  if (!node->any_of.empty()) {
    bool any_valid = false;
    for (const auto& sub : node->any_of) {
      std::vector<ata::validation_error> sub_errors;
      validate_napi(sub, value, env, path, ctx, sub_errors);
      if (sub_errors.empty()) {
        any_valid = true;
        break;
      }
    }
    if (!any_valid) {
      errors.push_back({ata::error_code::any_of_failed, path,
                        "no anyOf subschema matched"});
    }
  }

  // oneOf
  if (!node->one_of.empty()) {
    int match_count = 0;
    for (const auto& sub : node->one_of) {
      std::vector<ata::validation_error> sub_errors;
      validate_napi(sub, value, env, path, ctx, sub_errors);
      if (sub_errors.empty()) ++match_count;
    }
    if (match_count != 1) {
      errors.push_back({ata::error_code::one_of_failed, path,
                        "expected exactly one oneOf match, got " +
                            std::to_string(match_count)});
    }
  }

  // not
  if (node->not_schema) {
    std::vector<ata::validation_error> sub_errors;
    validate_napi(node->not_schema, value, env, path, ctx, sub_errors);
    if (sub_errors.empty()) {
      errors.push_back({ata::error_code::not_failed, path,
                        "value should not match 'not' schema"});
    }
  }

  // if/then/else
  if (node->if_schema) {
    std::vector<ata::validation_error> if_errors;
    validate_napi(node->if_schema, value, env, path, ctx, if_errors);
    if (if_errors.empty()) {
      if (node->then_schema) {
        validate_napi(node->then_schema, value, env, path, ctx, errors);
      }
    } else {
      if (node->else_schema) {
        validate_napi(node->else_schema, value, env, path, ctx, errors);
      }
    }
  }
}

// ============================================================================
// N-API Binding
// ============================================================================

static Napi::Object make_result(Napi::Env env,
                                const ata::validation_result& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("valid", Napi::Boolean::New(env, result.valid));
  Napi::Array errors = Napi::Array::New(env, result.errors.size());
  for (size_t i = 0; i < result.errors.size(); ++i) {
    Napi::Object err = Napi::Object::New(env);
    err.Set("code",
            Napi::Number::New(env, static_cast<int>(result.errors[i].code)));
    err.Set("path", Napi::String::New(env, result.errors[i].path));
    err.Set("message", Napi::String::New(env, result.errors[i].message));
    errors[i] = err;
  }
  obj.Set("errors", errors);
  return obj;
}

class CompiledSchema : public Napi::ObjectWrap<CompiledSchema> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(
        env, "CompiledSchema",
        {InstanceMethod("validate", &CompiledSchema::Validate),
         InstanceMethod("validateJSON", &CompiledSchema::ValidateJSON),
         InstanceMethod("validateDirect", &CompiledSchema::ValidateDirect),
         InstanceMethod("isValidJSON", &CompiledSchema::IsValidJSON)});
    auto* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);
    exports.Set("CompiledSchema", func);
    return exports;
  }

  CompiledSchema(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<CompiledSchema>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "Schema JSON string expected")
          .ThrowAsJavaScriptException();
      return;
    }
    std::string schema_json = info[0].As<Napi::String>().Utf8Value();
    schema_ = ata::compile(schema_json);
    if (!schema_) {
      Napi::Error::New(env, "Failed to compile schema")
          .ThrowAsJavaScriptException();
      return;
    }
    // Store internal pointers for direct validation
    auto* impl = reinterpret_cast<compiled_schema_internal*>(schema_.impl.get());
    internal_root_ = impl->root;
    internal_defs_ = &impl->defs;
  }

  // Validate any JS value directly via V8 traversal (no stringify needed)
  Napi::Value Validate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
      Napi::TypeError::New(env, "Argument expected")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return ValidateDirectImpl(env, info[0]);
  }

  // Thread-local reusable buffer for string extraction — avoids per-call allocation.
  // Sized with SIMDJSON_PADDING so simdjson can read safely beyond the JSON.
  static constexpr size_t TL_BUF_SHRINK_THRESHOLD = 64 * 1024; // 64KB

  static std::string& tl_json_buf() {
    thread_local std::string buf;
    return buf;
  }

  // Extract JS string into reusable thread-local buffer with simdjson padding.
  // Returns {data, length} — data is valid until next call on same thread.
  static std::pair<const char*, size_t> extract_string(napi_env env, napi_value val) {
    size_t len = 0;
    napi_get_value_string_utf8(env, val, nullptr, 0, &len);
    auto& buf = tl_json_buf();
    const size_t needed = len + 1 + ata::REQUIRED_PADDING;
    if (buf.size() < needed) buf.resize(needed);
    napi_get_value_string_utf8(env, val, buf.data(), len + 1, &len);
    // Shrink back if a one-off large string bloated the buffer
    if (buf.size() > TL_BUF_SHRINK_THRESHOLD && len < TL_BUF_SHRINK_THRESHOLD / 2) {
      buf.resize(TL_BUF_SHRINK_THRESHOLD);
      buf.shrink_to_fit();
    }
    return {buf.data(), len};
  }

  // Validate via JSON string (simdjson parse path)
  Napi::Value ValidateJSON(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
      Napi::TypeError::New(env, "JSON string expected")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // Support Buffer for zero-copy
    if (info[0].IsBuffer()) {
      auto buf = info[0].As<Napi::Buffer<char>>();
      auto result = ata::validate(schema_, std::string_view(buf.Data(), buf.Length()));
      return make_result(env, result);
    }
    if (!info[0].IsString()) {
      Napi::TypeError::New(env, "JSON string or Buffer expected")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto [data, len] = extract_string(env, info[0]);
    auto result = ata::validate(schema_, std::string_view(data, len));
    return make_result(env, result);
  }

  // Fast boolean-only validation — no error object creation
  Napi::Value IsValidJSON(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
      return Napi::Boolean::New(env, false);
    }
    // Support both String and Buffer inputs
    if (info[0].IsBuffer()) {
      auto buf = info[0].As<Napi::Buffer<char>>();
      auto result = ata::validate(schema_, std::string_view(buf.Data(), buf.Length()));
      return Napi::Boolean::New(env, result.valid);
    }
    if (!info[0].IsString()) {
      return Napi::Boolean::New(env, false);
    }
    auto [data, len] = extract_string(env, info[0]);
    // Buffer already has REQUIRED_PADDING — use zero-copy prepadded path
    bool valid = ata::is_valid_prepadded(schema_, data, len);
    return Napi::Boolean::New(env, valid);
  }

  // Explicit direct validation (always V8 traversal, never stringify)
  Napi::Value ValidateDirect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
      Napi::TypeError::New(env, "Argument expected")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return ValidateDirectImpl(env, info[0]);
  }

 private:
  Napi::Value ValidateDirectImpl(Napi::Env env, Napi::Value value) {
    compiled_schema_internal ctx;
    ctx.root = internal_root_;
    ctx.defs = *internal_defs_;

    std::vector<ata::validation_error> errors;
    validate_napi(internal_root_, value, env, "", ctx, errors);

    ata::validation_result result{errors.empty(), std::move(errors)};
    return make_result(env, result);
  }

  ata::schema_ref schema_;
  schema_node_ptr internal_root_;
  const std::unordered_map<std::string, schema_node_ptr>* internal_defs_ =
      nullptr;
};

// One-shot validate function (always V8 direct path)
Napi::Value ValidateOneShot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected (schemaJson, data)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string schema_json = info[0].As<Napi::String>().Utf8Value();

  auto schema = ata::compile(schema_json);
  if (!schema) {
    Napi::Error::New(env, "Failed to compile schema")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto* impl =
      reinterpret_cast<compiled_schema_internal*>(schema.impl.get());
  compiled_schema_internal ctx;
  ctx.root = impl->root;
  ctx.defs = impl->defs;

  std::vector<ata::validation_error> errors;
  validate_napi(impl->root, info[1], env, "", ctx, errors);

  ata::validation_result result{errors.empty(), std::move(errors)};
  return make_result(env, result);
}

Napi::Value GetVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), std::string(ata::version()));
}

// --- Thread Pool ---
class ThreadPool {
public:
  ThreadPool() {
    unsigned n = std::thread::hardware_concurrency();
    if (n == 0) n = 4;
    for (unsigned i = 0; i < n; i++) {
      workers_.emplace_back([this] {
        // Each thread gets its own schema cache
        std::unordered_map<uint32_t, ata::schema_ref> cache;
        while (true) {
          std::function<void(std::unordered_map<uint32_t, ata::schema_ref>&)> task;
          {
            std::unique_lock<std::mutex> lock(mtx_);
            cv_.wait(lock, [this] { return stop_ || !tasks_.empty(); });
            if (stop_ && tasks_.empty()) return;
            task = std::move(tasks_.front());
            tasks_.pop();
          }
          task(cache);
          {
            std::unique_lock<std::mutex> lock(done_mtx_);
            pending_--;
            if (pending_ == 0) done_cv_.notify_all();
          }
        }
      });
    }
  }

  void submit(std::function<void(std::unordered_map<uint32_t, ata::schema_ref>&)> task) {
    {
      std::unique_lock<std::mutex> lock(mtx_);
      tasks_.push(std::move(task));
    }
    {
      std::unique_lock<std::mutex> lock(done_mtx_);
      pending_++;
    }
    cv_.notify_one();
  }

  void wait() {
    std::unique_lock<std::mutex> lock(done_mtx_);
    done_cv_.wait(lock, [this] { return pending_ == 0; });
  }

  unsigned size() const { return (unsigned)workers_.size(); }

  ~ThreadPool() {
    { std::unique_lock<std::mutex> lock(mtx_); stop_ = true; }
    cv_.notify_all();
    for (auto& w : workers_) w.join();
  }

private:
  std::vector<std::thread> workers_;
  std::queue<std::function<void(std::unordered_map<uint32_t, ata::schema_ref>&)>> tasks_;
  std::mutex mtx_;
  std::condition_variable cv_;
  std::mutex done_mtx_;
  std::condition_variable done_cv_;
  std::atomic<int> pending_{0};
  bool stop_ = false;
};

static ThreadPool& pool() {
  static ThreadPool p;
  return p;
}

// --- Fast Validation Registry ---
// Global schema slots for V8 Fast API (bypasses NAPI overhead)
static constexpr size_t MAX_FAST_SLOTS = 4096;
static ata::schema_ref g_fast_schemas[MAX_FAST_SLOTS];
static std::string g_fast_schema_jsons[MAX_FAST_SLOTS];
static uint32_t g_fast_slot_count = 0;

// Register a compiled schema in a fast slot, returns slot ID
Napi::Value FastRegister(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Schema JSON string expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_fast_slot_count >= MAX_FAST_SLOTS) {
    Napi::Error::New(env, "Max fast schema slots reached").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string schema_json = info[0].As<Napi::String>().Utf8Value();
  auto schema = ata::compile(schema_json);
  if (!schema) {
    Napi::Error::New(env, "Failed to compile schema").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  uint32_t slot = g_fast_slot_count++;
  g_fast_schemas[slot] = std::move(schema);
  g_fast_schema_jsons[slot] = schema_json;
  return Napi::Number::New(env, slot);
}

// Fast validation: slot + Uint8Array → bool (called via V8 Fast API)
static bool FastValidateImpl(uint32_t slot, const uint8_t* data, size_t length) {
  if (slot >= g_fast_slot_count) return false;
  auto result = ata::validate(g_fast_schemas[slot],
                               std::string_view(reinterpret_cast<const char*>(data), length));
  return result.valid;
}

// Zero-copy validation with pre-padded buffer
static bool FastValidatePrepadded(uint32_t slot, const uint8_t* data, size_t length) {
  if (slot >= g_fast_slot_count) return false;
  return ata::is_valid_prepadded(g_fast_schemas[slot],
                                  reinterpret_cast<const char*>(data), length);
}

// Slow path (NAPI) — called when V8 can't use fast path
Napi::Value FastValidateSlow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber()) {
    return Napi::Boolean::New(env, false);
  }
  uint32_t slot = info[0].As<Napi::Number>().Uint32Value();
  if (info[1].IsTypedArray()) {
    auto arr = info[1].As<Napi::TypedArray>();
    if (arr.TypedArrayType() == napi_uint8_array) {
      auto u8 = info[1].As<Napi::Uint8Array>();
      bool ok = FastValidateImpl(slot, u8.Data(), u8.ByteLength());
      return Napi::Boolean::New(env, ok);
    }
  }
  if (info[1].IsBuffer()) {
    auto buf = info[1].As<Napi::Buffer<uint8_t>>();
    bool ok = FastValidateImpl(slot, buf.Data(), buf.Length());
    return Napi::Boolean::New(env, ok);
  }
  if (info[1].IsString()) {
    std::string json = info[1].As<Napi::String>().Utf8Value();
    bool ok = FastValidateImpl(slot, reinterpret_cast<const uint8_t*>(json.data()), json.size());
    return Napi::Boolean::New(env, ok);
  }
  return Napi::Boolean::New(env, false);
}

// --- Raw NAPI fast path (minimal overhead) ---
static napi_value RawFastValidate(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 2) {
    napi_value result;
    napi_get_boolean(env, false, &result);
    return result;
  }

  uint32_t slot;
  napi_get_value_uint32(env, args[0], &slot);

  // Check if pre-padded mode (3rd arg = json length, buffer has padding)
  bool prepadded = (argc >= 3);
  uint32_t json_length = 0;
  if (prepadded) {
    napi_get_value_uint32(env, args[2], &json_length);
  }

  bool valid = false;

  // Try typed array first (zero-copy)
  bool is_typedarray = false;
  napi_is_typedarray(env, args[1], &is_typedarray);

  if (is_typedarray) {
    napi_typedarray_type type;
    size_t length;
    void* data;
    napi_get_typedarray_info(env, args[1], &type, &length, &data, nullptr, nullptr);
    if (data) {
      size_t actual_len = prepadded ? json_length : length;
      if (prepadded) {
        valid = FastValidatePrepadded(slot, static_cast<const uint8_t*>(data), actual_len);
      } else {
        valid = FastValidateImpl(slot, static_cast<const uint8_t*>(data), actual_len);
      }
    }
  } else {
    bool is_buffer = false;
    napi_is_buffer(env, args[1], &is_buffer);
    if (is_buffer) {
      void* data;
      size_t length;
      napi_get_buffer_info(env, args[1], &data, &length);
      if (data) {
        size_t actual_len = prepadded ? json_length : length;
        if (prepadded) {
          valid = FastValidatePrepadded(slot, static_cast<const uint8_t*>(data), actual_len);
        } else {
          valid = FastValidateImpl(slot, static_cast<const uint8_t*>(data), actual_len);
        }
      }
    } else {
      // String — must copy (can't pre-pad strings)
      size_t len;
      napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
      if (len <= 4096) {
        char buf[4097];
        napi_get_value_string_utf8(env, args[1], buf, len + 1, &len);
        valid = FastValidateImpl(slot, reinterpret_cast<const uint8_t*>(buf), len);
      } else {
        std::string buf(len, '\0');
        napi_get_value_string_utf8(env, args[1], buf.data(), len + 1, &len);
        valid = FastValidateImpl(slot, reinterpret_cast<const uint8_t*>(buf.data()), len);
      }
    }
  }

  napi_value result;
  napi_get_boolean(env, valid, &result);
  return result;
}

// --- Batch validation: one NAPI call, N validations ---
static napi_value RawBatchValidate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  uint32_t slot;
  napi_get_value_uint32(env, args[0], &slot);
  if (slot >= g_fast_slot_count) {
    napi_value r;
    napi_get_null(env, &r);
    return r;
  }

  uint32_t arr_len;
  napi_get_array_length(env, args[1], &arr_len);

  napi_value result_arr;
  napi_create_array_with_length(env, arr_len, &result_arr);

  for (uint32_t i = 0; i < arr_len; i++) {
    napi_value item;
    napi_get_element(env, args[1], i, &item);

    bool valid = false;
    bool is_buffer = false;
    napi_is_buffer(env, item, &is_buffer);

    if (is_buffer) {
      void* data; size_t length;
      napi_get_buffer_info(env, item, &data, &length);
      if (data && length > 0)
        valid = ata::validate(g_fast_schemas[slot],
                  std::string_view(static_cast<const char*>(data), length)).valid;
    } else {
      bool is_ta = false;
      napi_is_typedarray(env, item, &is_ta);
      if (is_ta) {
        napi_typedarray_type type; size_t length; void* data;
        napi_get_typedarray_info(env, item, &type, &length, &data, nullptr, nullptr);
        if (data && length > 0)
          valid = ata::validate(g_fast_schemas[slot],
                    std::string_view(static_cast<const char*>(data), length)).valid;
      } else {
        size_t len;
        napi_get_value_string_utf8(env, item, nullptr, 0, &len);
        std::string buf(len, '\0');
        napi_get_value_string_utf8(env, item, buf.data(), len + 1, &len);
        valid = ata::validate(g_fast_schemas[slot], buf).valid;
      }
    }

    napi_value bval;
    napi_get_boolean(env, valid, &bval);
    napi_set_element(env, result_arr, i, bval);
  }
  return result_arr;
}

// --- Parallel NDJSON: multi-core validation, ajv can't do this ---
static napi_value RawParallelValidate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  uint32_t slot;
  napi_get_value_uint32(env, args[0], &slot);
  if (slot >= g_fast_slot_count) {
    napi_value r; napi_get_null(env, &r); return r;
  }

  const char* data = nullptr;
  size_t total_len = 0;
  bool is_buffer = false;
  napi_is_buffer(env, args[1], &is_buffer);
  if (is_buffer) {
    void* d; napi_get_buffer_info(env, args[1], &d, &total_len);
    data = static_cast<const char*>(d);
  } else {
    bool is_ta = false;
    napi_is_typedarray(env, args[1], &is_ta);
    if (is_ta) {
      napi_typedarray_type type; void* d;
      napi_get_typedarray_info(env, args[1], &type, &total_len, &d, nullptr, nullptr);
      data = static_cast<const char*>(d);
    }
  }
  if (!data || total_len == 0) {
    napi_value r; napi_create_array_with_length(env, 0, &r); return r;
  }

  // Split lines
  struct line { const char* ptr; size_t len; };
  std::vector<line> lines;
  const char* start = data;
  const char* end = data + total_len;
  while (start < end) {
    const char* nl = static_cast<const char*>(memchr(start, '\n', end - start));
    size_t line_len = nl ? (size_t)(nl - start) : (size_t)(end - start);
    if (line_len > 0) lines.push_back({start, line_len});
    start += line_len + 1;
  }

  size_t n = lines.size();
  std::vector<bool> results(n, false);

  // Parallel validation across CPU cores
  unsigned num_threads = std::thread::hardware_concurrency();
  if (num_threads == 0) num_threads = 4;
  if (num_threads > n) num_threads = (unsigned)n;

  // Each thread gets its own schema_ref (thread-safe: compile is one-time, validate is read-only)
  // But ata::validate uses internal parser that's NOT thread-safe
  // So each thread needs its own compiled schema
  const auto& schema_json = g_fast_schema_jsons[slot];

  if (schema_json.empty() || n < num_threads * 2) {
    // Fallback: single-threaded for small batches
    for (size_t i = 0; i < n; i++) {
      auto r = ata::validate(g_fast_schemas[slot], std::string_view(lines[i].ptr, lines[i].len));
      results[i] = r.valid;
    }
  } else {
    auto& tp = pool();
    unsigned nworkers = tp.size();
    size_t chunk = (n + nworkers - 1) / nworkers;

    for (unsigned t = 0; t < nworkers; t++) {
      size_t from = t * chunk;
      size_t to = std::min(from + chunk, n);
      if (from >= n) break;

      tp.submit([&results, &lines, from, to, slot](
          std::unordered_map<uint32_t, ata::schema_ref>& cache) {
        auto it = cache.find(slot);
        if (it == cache.end()) {
          it = cache.emplace(slot, ata::compile(g_fast_schema_jsons[slot])).first;
        }
        auto& s = it->second;
        // Free padding: lines in NDJSON buffer almost always have free padding
        // (next line's data serves as padding). Only last line might need copy.
        for (size_t i = from; i < to; i++) {
          results[i] = ata::is_valid_prepadded(s, lines[i].ptr, lines[i].len);
        }
      });
    }
    tp.wait();
  }

  napi_value result_arr;
  napi_create_array_with_length(env, n, &result_arr);
  for (size_t i = 0; i < n; i++) {
    napi_value bval;
    napi_get_boolean(env, results[i], &bval);
    napi_set_element(env, result_arr, (uint32_t)i, bval);
  }
  return result_arr;
}

// --- Parallel count: returns just the number of valid items (no array overhead) ---
static napi_value RawParallelCount(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  uint32_t slot;
  napi_get_value_uint32(env, args[0], &slot);
  if (slot >= g_fast_slot_count) {
    napi_value r; napi_create_uint32(env, 0, &r); return r;
  }

  const char* data = nullptr;
  size_t total_len = 0;
  bool is_buffer = false;
  napi_is_buffer(env, args[1], &is_buffer);
  if (is_buffer) {
    void* d; napi_get_buffer_info(env, args[1], &d, &total_len);
    data = static_cast<const char*>(d);
  } else {
    bool is_ta = false;
    napi_is_typedarray(env, args[1], &is_ta);
    if (is_ta) {
      napi_typedarray_type type; void* d;
      napi_get_typedarray_info(env, args[1], &type, &total_len, &d, nullptr, nullptr);
      data = static_cast<const char*>(d);
    }
  }
  if (!data || total_len == 0) {
    napi_value r; napi_create_uint32(env, 0, &r); return r;
  }

  struct line { const char* ptr; size_t len; };
  std::vector<line> lines;
  const char* start = data;
  const char* end = data + total_len;
  while (start < end) {
    const char* nl = static_cast<const char*>(memchr(start, '\n', end - start));
    size_t line_len = nl ? (size_t)(nl - start) : (size_t)(end - start);
    if (line_len > 0) lines.push_back({start, line_len});
    start += line_len + 1;
  }

  size_t n = lines.size();
  std::atomic<uint32_t> valid_count{0};

  auto& tp = pool();
  unsigned nworkers = tp.size();
  size_t chunk = (n + nworkers - 1) / nworkers;

  if (n < nworkers * 2) {
    // Small batch — single thread
    uint32_t cnt = 0;
    for (size_t i = 0; i < n; i++) {
      if (ata::validate(g_fast_schemas[slot], std::string_view(lines[i].ptr, lines[i].len)).valid)
        cnt++;
    }
    napi_value r; napi_create_uint32(env, cnt, &r); return r;
  }

  for (unsigned t = 0; t < nworkers; t++) {
    size_t from = t * chunk;
    size_t to = std::min(from + chunk, n);
    if (from >= n) break;

    tp.submit([&valid_count, &lines, from, to, slot](
        std::unordered_map<uint32_t, ata::schema_ref>& cache) {
      auto it = cache.find(slot);
      if (it == cache.end()) {
        it = cache.emplace(slot, ata::compile(g_fast_schema_jsons[slot])).first;
      }
      auto& s = it->second;
      uint32_t local_cnt = 0;
      for (size_t i = from; i < to; i++) {
        if (ata::is_valid_prepadded(s, lines[i].ptr, lines[i].len))
          local_cnt++;
      }
      valid_count.fetch_add(local_cnt, std::memory_order_relaxed);
    });
  }
  tp.wait();

  napi_value r;
  napi_create_uint32(env, valid_count.load(), &r);
  return r;
}

// --- NDJSON: single buffer, newline-delimited ---
static napi_value RawNDJSONValidate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  uint32_t slot;
  napi_get_value_uint32(env, args[0], &slot);
  if (slot >= g_fast_slot_count) {
    napi_value r; napi_get_null(env, &r); return r;
  }

  const char* data = nullptr;
  size_t total_len = 0;
  bool is_buffer = false;
  napi_is_buffer(env, args[1], &is_buffer);
  if (is_buffer) {
    void* d; napi_get_buffer_info(env, args[1], &d, &total_len);
    data = static_cast<const char*>(d);
  } else {
    bool is_ta = false;
    napi_is_typedarray(env, args[1], &is_ta);
    if (is_ta) {
      napi_typedarray_type type; void* d;
      napi_get_typedarray_info(env, args[1], &type, &total_len, &d, nullptr, nullptr);
      data = static_cast<const char*>(d);
    }
  }
  if (!data || total_len == 0) {
    napi_value r; napi_create_array_with_length(env, 0, &r); return r;
  }

  // Count lines first for array allocation
  uint32_t count = 0;
  for (size_t i = 0; i < total_len; i++) if (data[i] == '\n') count++;
  if (total_len > 0 && data[total_len-1] != '\n') count++;

  napi_value result_arr;
  napi_create_array_with_length(env, count, &result_arr);

  const char* start = data;
  const char* end = data + total_len;
  uint32_t idx = 0;

  while (start < end) {
    const char* nl = static_cast<const char*>(memchr(start, '\n', end - start));
    size_t line_len = nl ? (size_t)(nl - start) : (size_t)(end - start);
    if (line_len > 0) {
      auto r = ata::validate(g_fast_schemas[slot], std::string_view(start, line_len));
      napi_value bval;
      napi_get_boolean(env, r.valid, &bval);
      napi_set_element(env, result_arr, idx++, bval);
    }
    start += line_len + 1;
  }
  return result_arr;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  CompiledSchema::Init(env, exports);
  exports.Set("validate", Napi::Function::New(env, ValidateOneShot));
  exports.Set("version", Napi::Function::New(env, GetVersion));
  exports.Set("fastRegister", Napi::Function::New(env, FastRegister));
  exports.Set("fastValidate", Napi::Function::New(env, FastValidateSlow));

  napi_value raw_fn;
  napi_create_function(env, "rawFastValidate", NAPI_AUTO_LENGTH, RawFastValidate, nullptr, &raw_fn);
  exports.Set("rawFastValidate", Napi::Value(env, raw_fn));

  napi_value batch_fn;
  napi_create_function(env, "rawBatchValidate", NAPI_AUTO_LENGTH, RawBatchValidate, nullptr, &batch_fn);
  exports.Set("rawBatchValidate", Napi::Value(env, batch_fn));

  napi_value ndjson_fn;
  napi_create_function(env, "rawNDJSONValidate", NAPI_AUTO_LENGTH, RawNDJSONValidate, nullptr, &ndjson_fn);
  exports.Set("rawNDJSONValidate", Napi::Value(env, ndjson_fn));

  napi_value parallel_fn;
  napi_create_function(env, "rawParallelValidate", NAPI_AUTO_LENGTH, RawParallelValidate, nullptr, &parallel_fn);
  exports.Set("rawParallelValidate", Napi::Value(env, parallel_fn));

  napi_value pcount_fn;
  napi_create_function(env, "rawParallelCount", NAPI_AUTO_LENGTH, RawParallelCount, nullptr, &pcount_fn);
  exports.Set("rawParallelCount", Napi::Value(env, pcount_fn));

  return exports;
}

NODE_API_MODULE(ata, Init)
