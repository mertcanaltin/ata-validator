#include <napi.h>

#include <cmath>
#include <regex>
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
  std::vector<std::string> types;

  std::optional<double> minimum;
  std::optional<double> maximum;
  std::optional<double> exclusive_minimum;
  std::optional<double> exclusive_maximum;
  std::optional<double> multiple_of;

  std::optional<uint64_t> min_length;
  std::optional<uint64_t> max_length;
  std::optional<std::string> pattern;
  std::shared_ptr<std::regex> compiled_pattern;

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
    std::shared_ptr<std::regex> compiled;
  };
  std::vector<pattern_prop> pattern_properties;

  std::optional<std::string> enum_values_raw;
  std::vector<std::string> enum_values_minified;
  std::optional<std::string> const_value_raw;

  std::optional<std::string> format;

  std::vector<schema_node_ptr> all_of;
  std::vector<schema_node_ptr> any_of;
  std::vector<schema_node_ptr> one_of;
  schema_node_ptr not_schema;

  schema_node_ptr if_schema;
  schema_node_ptr then_schema;
  schema_node_ptr else_schema;

  std::string ref;

  std::optional<bool> boolean_schema;
};

struct compiled_schema_internal {
  schema_node_ptr root;
  std::unordered_map<std::string, schema_node_ptr> defs;
};

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
static std::string napi_to_json(Napi::Env env, Napi::Value val) {
  auto json = env.Global().Get("JSON").As<Napi::Object>();
  auto stringify = json.Get("stringify").As<Napi::Function>();
  auto result = stringify.Call(json, {val});
  if (result.IsString()) {
    return result.As<Napi::String>().Utf8Value();
  }
  if (val.IsUndefined()) return "null";
  return "null";
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

  // $ref
  if (!node->ref.empty()) {
    // First check defs map
    auto it = ctx.defs.find(node->ref);
    if (it != ctx.defs.end()) {
      validate_napi(it->second, value, env, path, ctx, errors);
      return;
    }
    // JSON Pointer resolution from root
    if (node->ref.size() > 1 && node->ref[0] == '#' &&
        node->ref[1] == '/') {
      std::string pointer = node->ref.substr(2);
      schema_node_ptr current = ctx.root;
      bool resolved = true;
      size_t pos = 0;
      while (pos < pointer.size() && current) {
        size_t next = pointer.find('/', pos);
        std::string segment =
            pointer.substr(pos, next == std::string::npos ? next : next - pos);
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
        if (key == "properties" && !current->properties.empty()) {
          pos = (next == std::string::npos) ? pointer.size() : next + 1;
          next = pointer.find('/', pos);
          std::string prop = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          auto pit = current->properties.find(prop);
          if (pit != current->properties.end()) current = pit->second;
          else { resolved = false; break; }
        } else if (key == "items" && current->items_schema) {
          current = current->items_schema;
        } else if (key == "$defs" || key == "definitions") {
          pos = (next == std::string::npos) ? pointer.size() : next + 1;
          next = pointer.find('/', pos);
          std::string def = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          auto dit = ctx.defs.find("#/" + key + "/" + def);
          if (dit != ctx.defs.end()) current = dit->second;
          else { resolved = false; break; }
        } else if (key == "allOf" || key == "anyOf" || key == "oneOf") {
          pos = (next == std::string::npos) ? pointer.size() : next + 1;
          next = pointer.find('/', pos);
          std::string idx_s = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          size_t idx = std::stoul(idx_s);
          auto& vec = (key == "allOf") ? current->all_of
                    : (key == "anyOf") ? current->any_of : current->one_of;
          if (idx < vec.size()) current = vec[idx];
          else { resolved = false; break; }
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
          std::string idx_s = pointer.substr(
              pos, next == std::string::npos ? next : next - pos);
          size_t idx = std::stoul(idx_s);
          if (idx < current->prefix_items.size()) current = current->prefix_items[idx];
          else { resolved = false; break; }
        } else { resolved = false; break; }
        pos = (next == std::string::npos) ? pointer.size() : next + 1;
      }
      if (resolved && current) {
        validate_napi(current, value, env, path, ctx, errors);
        return;
      }
    }
    if (node->ref == "#" && ctx.root) {
      validate_napi(ctx.root, value, env, path, ctx, errors);
      return;
    }
    errors.push_back({ata::error_code::ref_not_found, path,
                      "cannot resolve $ref: " + node->ref});
    return;
  }

  auto actual_type = napi_type_of(value);

  // type
  if (!node->types.empty()) {
    bool match = false;
    for (const auto& t : node->types) {
      if (napi_type_matches(value, t)) {
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
      errors.push_back({ata::error_code::type_mismatch, path,
                        "expected type " + expected + ", got " + actual_type});
    }
  }

  // enum
  if (node->enum_values_raw.has_value()) {
    std::string val_json = napi_to_json(env, value);
    // Parse enum from raw and compare
    bool found = false;
    // We need to compare against each element in the enum array
    // The enum_values_raw is a JSON array string like [1,2,3]
    // We'll use JSON.parse in JS to handle this
    auto json_obj = env.Global().Get("JSON").As<Napi::Object>();
    auto parse_fn = json_obj.Get("parse").As<Napi::Function>();
    auto enum_arr = parse_fn.Call(json_obj,
        {Napi::String::New(env, node->enum_values_raw.value())});
    if (enum_arr.IsArray()) {
      auto arr = enum_arr.As<Napi::Array>();
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        std::string elem_json = napi_to_json(env, arr.Get(i));
        if (elem_json == val_json) {
          found = true;
          break;
        }
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
      if (!std::regex_search(sv, *node->compiled_pattern)) {
        errors.push_back({ata::error_code::pattern_mismatch, path,
                          "string does not match pattern: " +
                              node->pattern.value()});
      }
    }
    if (node->format.has_value()) {
      const auto& fmt = node->format.value();
      bool format_ok = true;
      if (fmt == "email") {
        static const std::regex email_re(
            R"([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})");
        format_ok = std::regex_match(sv, email_re);
      } else if (fmt == "uri" || fmt == "uri-reference") {
        static const std::regex uri_re(R"([a-zA-Z][a-zA-Z0-9+\-.]*:.+)");
        format_ok = std::regex_match(sv, uri_re);
      } else if (fmt == "date") {
        static const std::regex date_re(R"(\d{4}-\d{2}-\d{2})");
        format_ok = std::regex_match(sv, date_re);
      } else if (fmt == "date-time") {
        static const std::regex dt_re(
            R"(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+\-]\d{2}:\d{2})?)");
        format_ok = std::regex_match(sv, dt_re);
      } else if (fmt == "time") {
        static const std::regex time_re(
            R"(\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+\-]\d{2}:\d{2})?)");
        format_ok = std::regex_match(sv, time_re);
      } else if (fmt == "ipv4") {
        static const std::regex ipv4_re(
            R"((\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}))");
        format_ok = std::regex_match(sv, ipv4_re);
      } else if (fmt == "ipv6") {
        format_ok = sv.find(':') != std::string::npos;
      } else if (fmt == "uuid") {
        static const std::regex uuid_re(
            R"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})");
        format_ok = std::regex_match(sv, uuid_re);
      } else if (fmt == "hostname") {
        static const std::regex host_re(
            R"([a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*)");
        format_ok = std::regex_match(sv, host_re);
      }
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
        if (pp.compiled && std::regex_search(key_str, *pp.compiled)) {
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
         InstanceMethod("validateDirect", &CompiledSchema::ValidateDirect)});
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

  // Validate via JSON string (simdjson parse path)
  Napi::Value ValidateJSON(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "JSON string expected")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string json = info[0].As<Napi::String>().Utf8Value();
    auto result = ata::validate(schema_, json);
    return make_result(env, result);
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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  CompiledSchema::Init(env, exports);
  exports.Set("validate", Napi::Function::New(env, ValidateOneShot));
  exports.Set("version", Napi::Function::New(env, GetVersion));
  return exports;
}

NODE_API_MODULE(ata, Init)
