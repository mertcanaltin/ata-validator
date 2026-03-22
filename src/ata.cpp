#include "ata.h"

#include <algorithm>
#include <cmath>
#include <re2/re2.h>
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

// Canonical JSON: sort object keys for semantic equality comparison
static std::string canonical_json(dom::element el) {
  switch (el.type()) {
    case dom::element_type::OBJECT: {
      dom::object obj; el.get(obj);
      std::vector<std::pair<std::string_view, dom::element>> entries;
      for (auto [k, v] : obj) entries.push_back({k, v});
      std::sort(entries.begin(), entries.end(),
                [](const auto& a, const auto& b) { return a.first < b.first; });
      std::string r = "{";
      for (size_t i = 0; i < entries.size(); ++i) {
        if (i) r += ',';
        r += '"';
        r += entries[i].first;
        r += "\":";
        r += canonical_json(entries[i].second);
      }
      r += '}';
      return r;
    }
    case dom::element_type::ARRAY: {
      dom::array arr; el.get(arr);
      std::string r = "[";
      bool first = true;
      for (auto v : arr) {
        if (!first) r += ',';
        first = false;
        r += canonical_json(v);
      }
      r += ']';
      return r;
    }
    default:
      return std::string(minify(el));
  }
}

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
  std::shared_ptr<re2::RE2> compiled_pattern;  // cached compiled regex (RE2)

  // array
  std::optional<uint64_t> min_items;
  std::optional<uint64_t> max_items;
  bool unique_items = false;
  schema_node_ptr items_schema;
  std::vector<schema_node_ptr> prefix_items;
  schema_node_ptr contains_schema;
  std::optional<uint64_t> min_contains;
  std::optional<uint64_t> max_contains;

  // object
  std::unordered_map<std::string, schema_node_ptr> properties;
  std::vector<std::string> required;
  std::optional<bool> additional_properties_bool;
  schema_node_ptr additional_properties_schema;
  std::optional<uint64_t> min_properties;
  std::optional<uint64_t> max_properties;
  schema_node_ptr property_names_schema;
  std::unordered_map<std::string, std::vector<std::string>> dependent_required;
  std::unordered_map<std::string, schema_node_ptr> dependent_schemas;

  // patternProperties — each entry: (pattern_string, schema, compiled_regex)
  struct pattern_prop {
    std::string pattern;
    schema_node_ptr schema;
    std::shared_ptr<re2::RE2> compiled;
  };
  std::vector<pattern_prop> pattern_properties;

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

  // $defs — stored on node for pointer navigation
  std::unordered_map<std::string, schema_node_ptr> defs;

  // boolean schema
  std::optional<bool> boolean_schema;
};

// --- Codegen: flat bytecode plan ---
namespace cg {
enum class op : uint8_t {
  END=0, EXPECT_OBJECT, EXPECT_ARRAY, EXPECT_STRING, EXPECT_NUMBER,
  EXPECT_INTEGER, EXPECT_BOOLEAN, EXPECT_NULL, EXPECT_TYPE_MULTI,
  CHECK_MINIMUM, CHECK_MAXIMUM, CHECK_EX_MINIMUM, CHECK_EX_MAXIMUM,
  CHECK_MULTIPLE_OF, CHECK_MIN_LENGTH, CHECK_MAX_LENGTH, CHECK_PATTERN,
  CHECK_FORMAT, CHECK_MIN_ITEMS, CHECK_MAX_ITEMS, CHECK_UNIQUE_ITEMS,
  ARRAY_ITEMS, CHECK_REQUIRED, CHECK_MIN_PROPS, CHECK_MAX_PROPS,
  OBJ_PROPS_START, OBJ_PROP, OBJ_PROPS_END, CHECK_NO_ADDITIONAL,
  CHECK_ENUM_STR, CHECK_ENUM, CHECK_CONST, COMPOSITION,
};
struct ins { op o; uint32_t a=0, b=0; };
struct plan {
  std::vector<ins> code;
  std::vector<double> doubles;
  std::vector<std::string> strings;
  std::vector<std::shared_ptr<re2::RE2>> regexes;
  std::vector<std::vector<std::string>> enum_sets;
  std::vector<std::vector<std::string>> type_sets;
  std::vector<uint8_t> format_ids;
  std::vector<std::vector<ins>> subs;
};
}  // namespace cg

struct compiled_schema {
  schema_node_ptr root;
  std::unordered_map<std::string, schema_node_ptr> defs;
  std::string raw_schema;
  dom::parser parser;
  dom::parser doc_parser;
  simdjson::ondemand::parser od_parser;  // On Demand parser for fast path
  cg::plan gen_plan;  // codegen validation plan
  bool use_ondemand = false;  // true if codegen plan supports On Demand
};

// --- Schema compilation ---

static schema_node_ptr compile_node(dom::element el,
                                    compiled_schema& ctx);

static schema_node_ptr compile_node(dom::element el,
                                    compiled_schema& ctx) {
  auto node = std::make_shared<schema_node>();

  // Boolean schema
  if (el.is<bool>()) {
    bool bval;
    el.get(bval);
    node->boolean_schema = bval;
    return node;
  }

  if (!el.is<dom::object>()) {
    return node;
  }

  dom::object obj;
  el.get(obj);

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
      dom::array type_arr; type_el.get(type_arr); for (auto t : type_arr) {
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
      auto re = std::make_shared<re2::RE2>(node->pattern.value());
      if (re->ok()) {
        node->compiled_pattern = std::move(re);
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
    dom::array pi_arr; pi_el.get(pi_arr); for (auto item : pi_arr) {
      node->prefix_items.push_back(compile_node(item, ctx));
    }
  }

  dom::element items_el;
  if (obj["items"].get(items_el) == SUCCESS) {
    node->items_schema = compile_node(items_el, ctx);
  }

  // contains
  dom::element contains_el;
  if (obj["contains"].get(contains_el) == SUCCESS) {
    node->contains_schema = compile_node(contains_el, ctx);
  }
  dom::element mc_el;
  if (obj["minContains"].get(mc_el) == SUCCESS) {
    uint64_t v;
    if (mc_el.get(v) == SUCCESS) node->min_contains = v;
  }
  if (obj["maxContains"].get(mc_el) == SUCCESS) {
    uint64_t v;
    if (mc_el.get(v) == SUCCESS) node->max_contains = v;
  }

  // object constraints
  dom::element props_el;
  if (obj["properties"].get(props_el) == SUCCESS && props_el.is<dom::object>()) {
    dom::object props_obj; props_el.get(props_obj); for (auto [key, val] : props_obj) {
      node->properties[std::string(key)] = compile_node(val, ctx);
    }
  }

  dom::element req_el;
  if (obj["required"].get(req_el) == SUCCESS && req_el.is<dom::array>()) {
    dom::array req_arr; req_el.get(req_arr); for (auto r : req_arr) {
      std::string_view sv;
      if (r.get(sv) == SUCCESS) {
        node->required.emplace_back(sv);
      }
    }
  }

  dom::element ap_el;
  if (obj["additionalProperties"].get(ap_el) == SUCCESS) {
    if (ap_el.is<bool>()) {
      bool ap_bool; ap_el.get(ap_bool); node->additional_properties_bool = ap_bool;
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

  // propertyNames
  dom::element pn_el;
  if (obj["propertyNames"].get(pn_el) == SUCCESS) {
    node->property_names_schema = compile_node(pn_el, ctx);
  }

  // dependentRequired
  dom::element dr_el;
  if (obj["dependentRequired"].get(dr_el) == SUCCESS &&
      dr_el.is<dom::object>()) {
    dom::object dr_obj; dr_el.get(dr_obj); for (auto [key, val] : dr_obj) {
      std::vector<std::string> deps;
      if (val.is<dom::array>()) {
        dom::array val_arr; val.get(val_arr); for (auto d : val_arr) {
          std::string_view sv;
          if (d.get(sv) == SUCCESS) deps.emplace_back(sv);
        }
      }
      node->dependent_required[std::string(key)] = std::move(deps);
    }
  }

  // dependentSchemas
  dom::element ds_el;
  if (obj["dependentSchemas"].get(ds_el) == SUCCESS &&
      ds_el.is<dom::object>()) {
    dom::object ds_obj; ds_el.get(ds_obj); for (auto [key, val] : ds_obj) {
      node->dependent_schemas[std::string(key)] = compile_node(val, ctx);
    }
  }

  // patternProperties — compile regex at schema compile time
  dom::element pp_el;
  if (obj["patternProperties"].get(pp_el) == SUCCESS &&
      pp_el.is<dom::object>()) {
    dom::object pp_obj; pp_el.get(pp_obj);
    for (auto [key, val] : pp_obj) {
      schema_node::pattern_prop pp;
      pp.pattern = std::string(key);
      pp.schema = compile_node(val, ctx);
      auto re = std::make_shared<re2::RE2>(pp.pattern);
      if (re->ok()) {
        pp.compiled = std::move(re);
      }
      node->pattern_properties.push_back(std::move(pp));
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
    node->enum_values_raw = canonical_json(enum_el);
    if (enum_el.is<dom::array>()) {
      dom::array enum_arr; enum_el.get(enum_arr); for (auto e : enum_arr) {
        node->enum_values_minified.push_back(canonical_json(e));
      }
    }
  }

  // const
  dom::element const_el;
  if (obj["const"].get(const_el) == SUCCESS) {
    node->const_value_raw = canonical_json(const_el);
  }

  // composition
  dom::element comp_el;
  if (obj["allOf"].get(comp_el) == SUCCESS && comp_el.is<dom::array>()) {
    dom::array comp_arr; comp_el.get(comp_arr);
    for (auto s : comp_arr) {
      node->all_of.push_back(compile_node(s, ctx));
    }
  }
  if (obj["anyOf"].get(comp_el) == SUCCESS && comp_el.is<dom::array>()) {
    dom::array comp_arr2; comp_el.get(comp_arr2);
    for (auto s : comp_arr2) {
      node->any_of.push_back(compile_node(s, ctx));
    }
  }
  if (obj["oneOf"].get(comp_el) == SUCCESS && comp_el.is<dom::array>()) {
    dom::array comp_arr3; comp_el.get(comp_arr3);
    for (auto s : comp_arr3) {
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
    dom::object defs_obj; defs_el.get(defs_obj); for (auto [key, val] : defs_obj) {
      std::string def_path = "#/$defs/" + std::string(key);
      auto compiled = compile_node(val, ctx);
      ctx.defs[def_path] = compiled;
      node->defs[std::string(key)] = compiled;
    }
  }
  if (obj["definitions"].get(defs_el) == SUCCESS &&
      defs_el.is<dom::object>()) {
    dom::object defs_obj; defs_el.get(defs_obj); for (auto [key, val] : defs_obj) {
      std::string def_path = "#/definitions/" + std::string(key);
      auto compiled = compile_node(val, ctx);
      ctx.defs[def_path] = compiled;
      node->defs[std::string(key)] = compiled;
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

  // $ref — Draft 2020-12: $ref is not a short-circuit, sibling keywords still apply
  bool ref_resolved = false;
  if (!node->ref.empty()) {
    // First check defs map
    auto it = ctx.defs.find(node->ref);
    if (it != ctx.defs.end()) {
      validate_node(it->second, value, path, ctx, errors, all_errors);
      ref_resolved = true;
    }
    // Try JSON Pointer resolution from root (e.g., "#/properties/foo")
    if (node->ref.size() > 1 && node->ref[0] == '#' &&
        node->ref[1] == '/') {
      // Decode JSON Pointer segments
      auto decode_pointer_segment = [](const std::string& seg) -> std::string {
        // Percent-decode first
        std::string pct;
        for (size_t i = 0; i < seg.size(); ++i) {
          if (seg[i] == '%' && i + 2 < seg.size()) {
            char h = seg[i+1], l = seg[i+2];
            auto hex = [](char c) -> int {
              if (c >= '0' && c <= '9') return c - '0';
              if (c >= 'a' && c <= 'f') return 10 + c - 'a';
              if (c >= 'A' && c <= 'F') return 10 + c - 'A';
              return -1;
            };
            int hv = hex(h), lv = hex(l);
            if (hv >= 0 && lv >= 0) {
              pct += static_cast<char>(hv * 16 + lv);
              i += 2;
            } else {
              pct += seg[i];
            }
          } else {
            pct += seg[i];
          }
        }
        // Then JSON Pointer unescape: ~1 -> /, ~0 -> ~
        std::string out;
        for (size_t i = 0; i < pct.size(); ++i) {
          if (pct[i] == '~' && i + 1 < pct.size()) {
            if (pct[i + 1] == '1') { out += '/'; ++i; }
            else if (pct[i + 1] == '0') { out += '~'; ++i; }
            else out += pct[i];
          } else {
            out += pct[i];
          }
        }
        return out;
      };

      // Split pointer into segments
      std::string pointer = node->ref.substr(2);
      std::vector<std::string> segments;
      size_t spos = 0;
      while (spos < pointer.size()) {
        size_t snext = pointer.find('/', spos);
        segments.push_back(decode_pointer_segment(
            pointer.substr(spos, snext == std::string::npos ? snext : snext - spos)));
        spos = (snext == std::string::npos) ? pointer.size() : snext + 1;
      }

      // Walk the schema tree
      schema_node_ptr current = ctx.root;
      bool resolved = true;
      for (size_t si = 0; si < segments.size() && current; ++si) {
        const auto& key = segments[si];

        if (key == "properties" && si + 1 < segments.size()) {
          const auto& prop_name = segments[++si];
          auto pit = current->properties.find(prop_name);
          if (pit != current->properties.end()) {
            current = pit->second;
          } else { resolved = false; break; }
        } else if (key == "items" && current->items_schema) {
          current = current->items_schema;
        } else if (key == "$defs" || key == "definitions") {
          if (si + 1 < segments.size()) {
            const auto& def_name = segments[++si];
            // Navigate into node's defs map
            auto dit = current->defs.find(def_name);
            if (dit != current->defs.end()) {
              current = dit->second;
            } else {
              // Fallback: try ctx.defs with full path
              std::string full_ref = "#/" + key + "/" + def_name;
              auto cit = ctx.defs.find(full_ref);
              if (cit != ctx.defs.end()) {
                current = cit->second;
              } else { resolved = false; break; }
            }
          } else { resolved = false; break; }
        } else if (key == "allOf" || key == "anyOf" || key == "oneOf") {
          if (si + 1 < segments.size()) {
            size_t idx = std::stoul(segments[++si]);
            auto& vec = (key == "allOf") ? current->all_of
                      : (key == "anyOf") ? current->any_of
                      : current->one_of;
            if (idx < vec.size()) { current = vec[idx]; }
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
            if (idx < current->prefix_items.size()) { current = current->prefix_items[idx]; }
            else { resolved = false; break; }
          } else { resolved = false; break; }
        } else {
          resolved = false; break;
        }
      }
      if (resolved && current) {
        validate_node(current, value, path, ctx, errors, all_errors);
        ref_resolved = true;
      }
    }
    // Self-reference: "#"
    if (!ref_resolved && node->ref == "#" && ctx.root) {
      validate_node(ctx.root, value, path, ctx, errors, all_errors);
      ref_resolved = true;
    }
    if (!ref_resolved) {
      errors.push_back({error_code::ref_not_found, path,
                        "cannot resolve $ref: " + node->ref});
    }
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
    std::string val_str = canonical_json(value);
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
    std::string val_str = canonical_json(value);
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
      if (!re2::RE2::PartialMatch(re2::StringPiece(sv.data(), sv.size()), *node->compiled_pattern)) {
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
    dom::array arr; value.get(arr);
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
        auto s = canonical_json(item);
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
                        path + "/" + std::to_string(idx), ctx, errors, all_errors);
        } else if (node->items_schema) {
          validate_node(node->items_schema, item,
                        path + "/" + std::to_string(idx), ctx, errors, all_errors);
        }
        ++idx;
      }
    }

    // contains / minContains / maxContains
    if (node->contains_schema) {
      uint64_t match_count = 0;
      for (auto item : arr) {
        std::vector<validation_error> tmp;
        validate_node(node->contains_schema, item, path, ctx, tmp, false);
        if (tmp.empty()) ++match_count;
      }
      uint64_t min_c = node->min_contains.value_or(1);
      uint64_t max_c = node->max_contains.value_or(arr_size);
      if (match_count < min_c) {
        errors.push_back({error_code::min_items_violation, path,
                          "contains: " + std::to_string(match_count) +
                              " matches, minimum " + std::to_string(min_c)});
      }
      if (match_count > max_c) {
        errors.push_back({error_code::max_items_violation, path,
                          "contains: " + std::to_string(match_count) +
                              " matches, maximum " + std::to_string(max_c)});
      }
    }
  }

  // Object validations
  if (actual_type == "object" && value.is<dom::object>()) {
    dom::object obj; value.get(obj);
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

      // Check patternProperties (use cached compiled regex)
      for (const auto& pp : node->pattern_properties) {
        if (pp.compiled && re2::RE2::PartialMatch(key_str, *pp.compiled)) {
          validate_node(pp.schema, val, path + "/" + key_str, ctx, errors, all_errors);
          matched = true;
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

    // propertyNames
    if (node->property_names_schema) {
      for (auto [key, val] : obj) {
        // Create a string element to validate the key
        std::string key_json = "\"" + std::string(key) + "\"";
        dom::parser key_parser;
        auto key_result = key_parser.parse(key_json);
        if (!key_result.error()) {
          validate_node(node->property_names_schema, key_result.value(),
                        path, ctx, errors, all_errors);
        }
      }
    }

    // dependentRequired
    for (const auto& [prop, deps] : node->dependent_required) {
      dom::element dummy;
      if (obj[prop].get(dummy) == SUCCESS) {
        for (const auto& dep : deps) {
          dom::element dep_dummy;
          if (obj[dep].get(dep_dummy) != SUCCESS) {
            errors.push_back({error_code::required_property_missing, path,
                              "property '" + prop + "' requires '" + dep +
                                  "' to be present"});
          }
        }
      }
    }

    // dependentSchemas
    for (const auto& [prop, schema] : node->dependent_schemas) {
      dom::element dummy;
      if (obj[prop].get(dummy) == SUCCESS) {
        validate_node(schema, value, path, ctx, errors, all_errors);
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

// --- Codegen compiler ---
static void cg_compile(const schema_node* n, cg::plan& p,
                        std::vector<cg::ins>& out) {
  if (!n) return;
  if (n->boolean_schema.has_value()) {
    if (!*n->boolean_schema) out.push_back({cg::op::EXPECT_NULL});
    return;
  }
  // Composition fallback
  if (!n->ref.empty() || !n->all_of.empty() || !n->any_of.empty() ||
      !n->one_of.empty() || n->not_schema || n->if_schema) {
    uintptr_t ptr = reinterpret_cast<uintptr_t>(n);
    out.push_back({cg::op::COMPOSITION, (uint32_t)(ptr & 0xFFFFFFFF),
                   (uint32_t)((ptr >> 32) & 0xFFFFFFFF)});
    return;
  }
  // Type
  if (!n->types.empty()) {
    if (n->types.size() == 1) {
      auto& t = n->types[0];
      if (t=="object") out.push_back({cg::op::EXPECT_OBJECT});
      else if (t=="array") out.push_back({cg::op::EXPECT_ARRAY});
      else if (t=="string") out.push_back({cg::op::EXPECT_STRING});
      else if (t=="number") out.push_back({cg::op::EXPECT_NUMBER});
      else if (t=="integer") out.push_back({cg::op::EXPECT_INTEGER});
      else if (t=="boolean") out.push_back({cg::op::EXPECT_BOOLEAN});
      else if (t=="null") out.push_back({cg::op::EXPECT_NULL});
    } else {
      uint32_t i = (uint32_t)p.type_sets.size();
      p.type_sets.push_back(n->types);
      out.push_back({cg::op::EXPECT_TYPE_MULTI, i});
    }
  }
  // Enum
  if (!n->enum_values_minified.empty()) {
    bool all_str = true;
    for (auto& e : n->enum_values_minified)
      if (e.empty() || e[0]!='"') { all_str=false; break; }
    uint32_t i = (uint32_t)p.enum_sets.size();
    p.enum_sets.push_back(n->enum_values_minified);
    out.push_back({all_str ? cg::op::CHECK_ENUM_STR : cg::op::CHECK_ENUM, i});
  }
  if (n->const_value_raw.has_value()) {
    uint32_t i=(uint32_t)p.strings.size();
    p.strings.push_back(*n->const_value_raw);
    out.push_back({cg::op::CHECK_CONST, i});
  }
  // Numeric
  if (n->minimum.has_value()) { uint32_t i=(uint32_t)p.doubles.size(); p.doubles.push_back(*n->minimum); out.push_back({cg::op::CHECK_MINIMUM,i}); }
  if (n->maximum.has_value()) { uint32_t i=(uint32_t)p.doubles.size(); p.doubles.push_back(*n->maximum); out.push_back({cg::op::CHECK_MAXIMUM,i}); }
  if (n->exclusive_minimum.has_value()) { uint32_t i=(uint32_t)p.doubles.size(); p.doubles.push_back(*n->exclusive_minimum); out.push_back({cg::op::CHECK_EX_MINIMUM,i}); }
  if (n->exclusive_maximum.has_value()) { uint32_t i=(uint32_t)p.doubles.size(); p.doubles.push_back(*n->exclusive_maximum); out.push_back({cg::op::CHECK_EX_MAXIMUM,i}); }
  if (n->multiple_of.has_value()) { uint32_t i=(uint32_t)p.doubles.size(); p.doubles.push_back(*n->multiple_of); out.push_back({cg::op::CHECK_MULTIPLE_OF,i}); }
  // String
  if (n->min_length.has_value()) out.push_back({cg::op::CHECK_MIN_LENGTH,(uint32_t)*n->min_length});
  if (n->max_length.has_value()) out.push_back({cg::op::CHECK_MAX_LENGTH,(uint32_t)*n->max_length});
  if (n->compiled_pattern) { uint32_t i=(uint32_t)p.regexes.size(); p.regexes.push_back(n->compiled_pattern); out.push_back({cg::op::CHECK_PATTERN,i}); }
  if (n->format.has_value()) {
    uint32_t i=(uint32_t)p.format_ids.size();
    uint8_t fid=255;
    auto& f=*n->format;
    if(f=="email")fid=0;else if(f=="date")fid=1;else if(f=="date-time")fid=2;
    else if(f=="time")fid=3;else if(f=="ipv4")fid=4;else if(f=="ipv6")fid=5;
    else if(f=="uri"||f=="uri-reference")fid=6;else if(f=="uuid")fid=7;
    else if(f=="hostname")fid=8;
    p.format_ids.push_back(fid);
    out.push_back({cg::op::CHECK_FORMAT,i});
  }
  // Array
  if (n->min_items.has_value()) out.push_back({cg::op::CHECK_MIN_ITEMS,(uint32_t)*n->min_items});
  if (n->max_items.has_value()) out.push_back({cg::op::CHECK_MAX_ITEMS,(uint32_t)*n->max_items});
  if (n->unique_items) out.push_back({cg::op::CHECK_UNIQUE_ITEMS});
  if (n->items_schema) {
    uint32_t si=(uint32_t)p.subs.size();
    p.subs.emplace_back();
    std::vector<cg::ins> sub_code;
    cg_compile(n->items_schema.get(), p, sub_code);
    sub_code.push_back({cg::op::END});
    p.subs[si] = std::move(sub_code);
    out.push_back({cg::op::ARRAY_ITEMS, si});
  }
  // Object
  for (auto& r : n->required) { uint32_t i=(uint32_t)p.strings.size(); p.strings.push_back(r); out.push_back({cg::op::CHECK_REQUIRED,i}); }
  if (n->min_properties.has_value()) out.push_back({cg::op::CHECK_MIN_PROPS,(uint32_t)*n->min_properties});
  if (n->max_properties.has_value()) out.push_back({cg::op::CHECK_MAX_PROPS,(uint32_t)*n->max_properties});
  // additional_properties_schema requires tree walker — bail out to COMPOSITION
  if (n->additional_properties_schema) {
    out.push_back({cg::op::COMPOSITION, 0, 0});
    return;
  }
  if (!n->properties.empty() || (n->additional_properties_bool.has_value() && !*n->additional_properties_bool)) {
    out.push_back({cg::op::OBJ_PROPS_START});
    if (n->additional_properties_bool.has_value() && !*n->additional_properties_bool)
      out.push_back({cg::op::CHECK_NO_ADDITIONAL});
    for (auto& [name, schema] : n->properties) {
      uint32_t ni=(uint32_t)p.strings.size(); p.strings.push_back(name);
      uint32_t si=(uint32_t)p.subs.size();
      p.subs.emplace_back();
      std::vector<cg::ins> sub_code;
      cg_compile(schema.get(), p, sub_code);
      sub_code.push_back({cg::op::END});
      p.subs[si] = std::move(sub_code);
      out.push_back({cg::op::OBJ_PROP, ni, si});
    }
    out.push_back({cg::op::OBJ_PROPS_END});
  }
}

// --- Codegen executor ---
static const char* fmt_names[]={"email","date","date-time","time","ipv4","ipv6","uri","uuid","hostname"};

static bool cg_exec(const cg::plan& p, const std::vector<cg::ins>& code,
                     dom::element value) {
  auto t = type_of_sv(value);
  for (size_t i=0; i<code.size(); ++i) {
    auto& c = code[i];
    switch(c.o) {
    case cg::op::END: return true;
    case cg::op::EXPECT_OBJECT: if(t!="object") return false; break;
    case cg::op::EXPECT_ARRAY: if(t!="array") return false; break;
    case cg::op::EXPECT_STRING: if(t!="string") return false; break;
    case cg::op::EXPECT_NUMBER: if(t!="number"&&t!="integer") return false; break;
    case cg::op::EXPECT_INTEGER: if(t!="integer") return false; break;
    case cg::op::EXPECT_BOOLEAN: if(t!="boolean") return false; break;
    case cg::op::EXPECT_NULL: if(t!="null") return false; break;
    case cg::op::EXPECT_TYPE_MULTI: {
      auto& ts=p.type_sets[c.a]; bool m=false;
      for(auto& ty:ts){if(t==ty||(ty=="number"&&(t=="integer"||t=="number"))){m=true;break;}}
      if(!m) return false; break;
    }
    case cg::op::CHECK_MINIMUM: if(t=="integer"||t=="number"){if(to_double(value)<p.doubles[c.a])return false;} break;
    case cg::op::CHECK_MAXIMUM: if(t=="integer"||t=="number"){if(to_double(value)>p.doubles[c.a])return false;} break;
    case cg::op::CHECK_EX_MINIMUM: if(t=="integer"||t=="number"){if(to_double(value)<=p.doubles[c.a])return false;} break;
    case cg::op::CHECK_EX_MAXIMUM: if(t=="integer"||t=="number"){if(to_double(value)>=p.doubles[c.a])return false;} break;
    case cg::op::CHECK_MULTIPLE_OF: if(t=="integer"||t=="number"){double v=to_double(value),d=p.doubles[c.a],r=std::fmod(v,d);if(std::abs(r)>1e-8&&std::abs(r-d)>1e-8)return false;} break;
    case cg::op::CHECK_MIN_LENGTH: if(t=="string"){std::string_view sv;value.get(sv);if(utf8_length(sv)<c.a)return false;} break;
    case cg::op::CHECK_MAX_LENGTH: if(t=="string"){std::string_view sv;value.get(sv);if(utf8_length(sv)>c.a)return false;} break;
    case cg::op::CHECK_PATTERN: if(t=="string"){std::string_view sv;value.get(sv);if(!re2::RE2::PartialMatch(re2::StringPiece(sv.data(),sv.size()),*p.regexes[c.a]))return false;} break;
    case cg::op::CHECK_FORMAT: if(t=="string"){std::string_view sv;value.get(sv);uint8_t f=p.format_ids[c.a];if(f<9&&!check_format(sv,fmt_names[f]))return false;} break;
    case cg::op::CHECK_MIN_ITEMS: if(t=="array"){dom::array a;value.get(a);uint64_t s=0;for([[maybe_unused]]auto _:a)++s;if(s<c.a)return false;} break;
    case cg::op::CHECK_MAX_ITEMS: if(t=="array"){dom::array a;value.get(a);uint64_t s=0;for([[maybe_unused]]auto _:a)++s;if(s>c.a)return false;} break;
    case cg::op::CHECK_UNIQUE_ITEMS: if(t=="array"){dom::array a;value.get(a);std::set<std::string> seen;for(auto x:a)if(!seen.insert(canonical_json(x)).second)return false;} break;
    case cg::op::ARRAY_ITEMS: if(t=="array"){dom::array a;value.get(a);for(auto x:a)if(!cg_exec(p,p.subs[c.a],x))return false;} break;
    case cg::op::CHECK_REQUIRED: if(t=="object"){dom::object o;value.get(o);dom::element d;if(o[p.strings[c.a]].get(d)!=SUCCESS)return false;} break;
    case cg::op::CHECK_MIN_PROPS: if(t=="object"){dom::object o;value.get(o);uint64_t n=0;for([[maybe_unused]]auto _:o)++n;if(n<c.a)return false;} break;
    case cg::op::CHECK_MAX_PROPS: if(t=="object"){dom::object o;value.get(o);uint64_t n=0;for([[maybe_unused]]auto _:o)++n;if(n>c.a)return false;} break;
    case cg::op::OBJ_PROPS_START: if(t=="object"){
      dom::object o; value.get(o);
      // collect prop defs
      struct pd{std::string_view nm;uint32_t si;};
      std::vector<pd> props; bool no_add=false;
      size_t j=i+1;
      for(;j<code.size()&&code[j].o!=cg::op::OBJ_PROPS_END;++j){
        if(code[j].o==cg::op::OBJ_PROP) props.push_back({p.strings[code[j].a],code[j].b});
        else if(code[j].o==cg::op::CHECK_NO_ADDITIONAL) no_add=true;
      }
      for(auto [key,val]:o){
        bool matched=false;
        for(auto& pp:props){if(key==pp.nm){if(!cg_exec(p,p.subs[pp.si],val))return false;matched=true;break;}}
        if(!matched&&no_add)return false;
      }
      i=j; break;
    } else { /* skip to OBJ_PROPS_END */ size_t j=i+1; for(;j<code.size()&&code[j].o!=cg::op::OBJ_PROPS_END;++j); i=j; } break;
    case cg::op::OBJ_PROP: case cg::op::OBJ_PROPS_END: case cg::op::CHECK_NO_ADDITIONAL: break;
    case cg::op::CHECK_ENUM_STR: {
      auto& es=p.enum_sets[c.a]; bool f=false;
      if(t=="string"){std::string_view sv;value.get(sv);for(auto& e:es)if(e.size()==sv.size()+2&&e[0]=='"'&&e.back()=='"'&&e.compare(1,sv.size(),sv)==0){f=true;break;}}
      if(!f){std::string v=canonical_json(value);for(auto& e:es)if(e==v){f=true;break;}}
      if(!f)return false; break;
    }
    case cg::op::CHECK_ENUM: {
      auto& es=p.enum_sets[c.a]; bool f=false;
      if(t=="string"){std::string_view sv;value.get(sv);for(auto& e:es)if(e.size()==sv.size()+2&&e[0]=='"'&&e.back()=='"'&&e.compare(1,sv.size(),sv)==0){f=true;break;}}
      if(!f&&value.is<int64_t>()){int64_t v;value.get(v);auto s=std::to_string(v);for(auto& e:es)if(e==s){f=true;break;}}
      if(!f){std::string v=canonical_json(value);for(auto& e:es)if(e==v){f=true;break;}}
      if(!f)return false; break;
    }
    case cg::op::CHECK_CONST: if(canonical_json(value)!=p.strings[c.a])return false; break;
    case cg::op::COMPOSITION: return false; // fallback to tree walker
    }
  }
  return true;
}

// --- On Demand fast path executor ---
// Uses simdjson On Demand API to avoid materializing the full DOM tree.
// Returns: true = valid, false = invalid OR unsupported (fallback to DOM).

static std::string_view od_type(simdjson::ondemand::value& v) {
  switch (v.type()) {
    case simdjson::ondemand::json_type::object: return "object";
    case simdjson::ondemand::json_type::array: return "array";
    case simdjson::ondemand::json_type::string: return "string";
    case simdjson::ondemand::json_type::boolean: return "boolean";
    case simdjson::ondemand::json_type::null: return "null";
    case simdjson::ondemand::json_type::number: {
      simdjson::ondemand::number_type nt;
      if (v.get_number_type().get(nt) == SUCCESS &&
          nt == simdjson::ondemand::number_type::floating_point_number)
        return "number";
      return "integer";
    }
  }
  return "unknown";
}

static bool od_exec(const cg::plan& p, const std::vector<cg::ins>& code,
                     simdjson::ondemand::value value) {
  auto t = od_type(value);
  for (size_t i = 0; i < code.size(); ++i) {
    auto& c = code[i];
    switch (c.o) {
    case cg::op::END: return true;
    case cg::op::EXPECT_OBJECT: if(t!="object") return false; break;
    case cg::op::EXPECT_ARRAY: if(t!="array") return false; break;
    case cg::op::EXPECT_STRING: if(t!="string") return false; break;
    case cg::op::EXPECT_NUMBER: if(t!="number"&&t!="integer") return false; break;
    case cg::op::EXPECT_INTEGER: if(t!="integer") return false; break;
    case cg::op::EXPECT_BOOLEAN: if(t!="boolean") return false; break;
    case cg::op::EXPECT_NULL: if(t!="null") return false; break;
    case cg::op::EXPECT_TYPE_MULTI: {
      auto& ts=p.type_sets[c.a]; bool m=false;
      for(auto& ty:ts){if(t==ty||(ty=="number"&&(t=="integer"||t=="number"))){m=true;break;}}
      if(!m) return false; break;
    }
    case cg::op::CHECK_MINIMUM:
    case cg::op::CHECK_MAXIMUM:
    case cg::op::CHECK_EX_MINIMUM:
    case cg::op::CHECK_EX_MAXIMUM:
    case cg::op::CHECK_MULTIPLE_OF: {
      if (t=="integer"||t=="number") {
        double v;
        if (t=="integer") { int64_t iv; if(value.get(iv)!=SUCCESS) return false; v=(double)iv; }
        else { if(value.get(v)!=SUCCESS) return false; }
        double d=p.doubles[c.a];
        if(c.o==cg::op::CHECK_MINIMUM && v<d) return false;
        if(c.o==cg::op::CHECK_MAXIMUM && v>d) return false;
        if(c.o==cg::op::CHECK_EX_MINIMUM && v<=d) return false;
        if(c.o==cg::op::CHECK_EX_MAXIMUM && v>=d) return false;
        if(c.o==cg::op::CHECK_MULTIPLE_OF){double r=std::fmod(v,d);if(std::abs(r)>1e-8&&std::abs(r-d)>1e-8)return false;}
      }
      break;
    }
    case cg::op::CHECK_MIN_LENGTH: if(t=="string"){std::string_view sv; if(value.get(sv)!=SUCCESS) return false; if(utf8_length(sv)<c.a) return false;} break;
    case cg::op::CHECK_MAX_LENGTH: if(t=="string"){std::string_view sv; if(value.get(sv)!=SUCCESS) return false; if(utf8_length(sv)>c.a) return false;} break;
    case cg::op::CHECK_PATTERN: if(t=="string"){std::string_view sv; if(value.get(sv)!=SUCCESS) return false; if(!re2::RE2::PartialMatch(re2::StringPiece(sv.data(),sv.size()),*p.regexes[c.a]))return false;} break;
    case cg::op::CHECK_FORMAT: if(t=="string"){std::string_view sv; if(value.get(sv)!=SUCCESS) return false; uint8_t f=p.format_ids[c.a]; if(f<9&&!check_format(sv,fmt_names[f]))return false;} break;
    case cg::op::CHECK_MIN_ITEMS: if(t=="array"){
      simdjson::ondemand::array a; if(value.get(a)!=SUCCESS) return false;
      uint64_t s=0; for(auto x:a){(void)x;++s;} if(s<c.a) return false;
    } break;
    case cg::op::CHECK_MAX_ITEMS: if(t=="array"){
      simdjson::ondemand::array a; if(value.get(a)!=SUCCESS) return false;
      uint64_t s=0; for(auto x:a){(void)x;++s;} if(s>c.a) return false;
    } break;
    case cg::op::ARRAY_ITEMS: if(t=="array"){
      simdjson::ondemand::array a; if(value.get(a)!=SUCCESS) return false;
      for(auto elem:a){
        simdjson::ondemand::value v; if(elem.get(v)!=SUCCESS) return false;
        if(!od_exec(p,p.subs[c.a],v)) return false;
      }
    } break;
    case cg::op::CHECK_REQUIRED: if(t=="object"){
      simdjson::ondemand::object o; if(value.get(o)!=SUCCESS) return false;
      auto f = o.find_field_unordered(p.strings[c.a]);
      if(f.error()) return false;
    } break;
    case cg::op::CHECK_MIN_PROPS: if(t=="object"){
      simdjson::ondemand::object o; if(value.get(o)!=SUCCESS) return false;
      uint64_t n=0; for(auto f:o){(void)f;++n;} if(n<c.a) return false;
    } break;
    case cg::op::CHECK_MAX_PROPS: if(t=="object"){
      simdjson::ondemand::object o; if(value.get(o)!=SUCCESS) return false;
      uint64_t n=0; for(auto f:o){(void)f;++n;} if(n>c.a) return false;
    } break;
    case cg::op::OBJ_PROPS_START: if(t=="object"){
      simdjson::ondemand::object o; if(value.get(o)!=SUCCESS) return false;
      struct pd{std::string_view nm;uint32_t si;};
      std::vector<pd> props; bool no_add=false;
      size_t j=i+1;
      for(;j<code.size()&&code[j].o!=cg::op::OBJ_PROPS_END;++j){
        if(code[j].o==cg::op::OBJ_PROP) props.push_back({p.strings[code[j].a],code[j].b});
        else if(code[j].o==cg::op::CHECK_NO_ADDITIONAL) no_add=true;
      }
      for(auto field:o){
        simdjson::ondemand::raw_json_string rk; if(field.key().get(rk)!=SUCCESS) return false;
        std::string_view key = field.unescaped_key();
        bool matched=false;
        for(auto& pp:props){
          if(key==pp.nm){
            simdjson::ondemand::value fv; if(field.value().get(fv)!=SUCCESS) return false;
            if(!od_exec(p,p.subs[pp.si],fv)) return false;
            matched=true; break;
          }
        }
        if(!matched&&no_add) return false;
      }
      i=j; break;
    } else { size_t j=i+1; for(;j<code.size()&&code[j].o!=cg::op::OBJ_PROPS_END;++j); i=j; } break;
    case cg::op::OBJ_PROP: case cg::op::OBJ_PROPS_END: case cg::op::CHECK_NO_ADDITIONAL: break;

    // These require full materialization — bail to DOM path
    case cg::op::CHECK_UNIQUE_ITEMS:
    case cg::op::CHECK_ENUM_STR:
    case cg::op::CHECK_ENUM:
    case cg::op::CHECK_CONST:
    case cg::op::COMPOSITION:
      return false;
    }
  }
  return true;
}

// Determine if a codegen plan can use On Demand (no enum/const/uniqueItems)
static bool plan_supports_ondemand(const cg::plan& p) {
  for (auto& c : p.code) {
    if (c.o == cg::op::CHECK_UNIQUE_ITEMS || c.o == cg::op::CHECK_ENUM_STR ||
        c.o == cg::op::CHECK_ENUM || c.o == cg::op::CHECK_CONST ||
        c.o == cg::op::COMPOSITION)
      return false;
  }
  // Also check sub-plans
  for (auto& sub : p.subs) {
    for (auto& c : sub) {
      if (c.o == cg::op::CHECK_UNIQUE_ITEMS || c.o == cg::op::CHECK_ENUM_STR ||
          c.o == cg::op::CHECK_ENUM || c.o == cg::op::CHECK_CONST ||
          c.o == cg::op::COMPOSITION)
        return false;
    }
  }
  return true;
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

  // Generate codegen plan
  cg_compile(ctx->root.get(), ctx->gen_plan, ctx->gen_plan.code);
  ctx->gen_plan.code.push_back({cg::op::END});
  ctx->use_ondemand = plan_supports_ondemand(ctx->gen_plan);

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

  // Ultra-fast path: On Demand (no DOM materialization)
  // Only beneficial for larger documents where DOM materialization cost dominates
  static constexpr size_t OD_THRESHOLD = 32;
  if (schema.impl->use_ondemand && !schema.impl->gen_plan.code.empty() &&
      json.size() >= OD_THRESHOLD) {
    auto od_result = schema.impl->od_parser.iterate(padded);
    if (!od_result.error()) {
      simdjson::ondemand::value root_val;
      if (od_result.get_value().get(root_val) == SUCCESS) {
        if (od_exec(schema.impl->gen_plan, schema.impl->gen_plan.code, root_val)) {
          return {true, {}};
        }
      }
    }
    // On Demand said invalid — fall through to DOM for error details
  }

  auto result = schema.impl->doc_parser.parse(padded);
  if (result.error()) {
    return {false, {{error_code::invalid_json, "", "invalid JSON document"}}};
  }

  // Fast path: codegen bytecode execution (DOM)
  if (!schema.impl->use_ondemand && !schema.impl->gen_plan.code.empty()) {
    if (cg_exec(schema.impl->gen_plan, schema.impl->gen_plan.code,
                result.value())) {
      return {true, {}};
    }
    // Codegen said invalid OR hit COMPOSITION — fall through to tree walker
  }

  // Slow path: re-parse + tree walker with error details
  auto result2 = schema.impl->doc_parser.parse(padded);
  std::vector<validation_error> errors;
  validate_node(schema.impl->root, result2.value(), "", *schema.impl, errors,
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
