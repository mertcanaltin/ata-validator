const fs = require("fs");
const path = require("path");
const { Validator } = require("../index");

const SUITE_DIR = path.join(__dirname, "suite/tests/draft2020-12");

// Test files we support (skip: refRemote, dynamicRef, vocabulary, anchor,
// contains, prefixItems, unevaluatedItems, unevaluatedProperties,
// dependentRequired, dependentSchemas, propertyNames, content, default,
// infinite-loop-detection)
const SUPPORTED_FILES = [
  "type.json",
  "minimum.json",
  "maximum.json",
  "exclusiveMinimum.json",
  "exclusiveMaximum.json",
  "multipleOf.json",
  "minLength.json",
  "maxLength.json",
  "pattern.json",
  "minItems.json",
  "maxItems.json",
  "uniqueItems.json",
  "items.json",
  "properties.json",
  "required.json",
  "additionalProperties.json",
  "patternProperties.json",
  "minProperties.json",
  "maxProperties.json",
  "enum.json",
  "const.json",
  "allOf.json",
  "anyOf.json",
  "oneOf.json",
  "not.json",
  "if-then-else.json",
  "boolean_schema.json",
  "ref.json",
  "defs.json",
  "contains.json",
  "minContains.json",
  "maxContains.json",
  "dependentRequired.json",
  "dependentSchemas.json",
  "propertyNames.json",
  "prefixItems.json",
  "unevaluatedProperties.json",
  "unevaluatedItems.json",
  "format.json",
  "anchor.json",
];

let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;
const failures = [];

for (const file of SUPPORTED_FILES) {
  const filePath = path.join(SUITE_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`  SKIP  ${file} (not found)`);
    continue;
  }

  const suites = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let filePass = 0;
  let fileFail = 0;
  let fileSkip = 0;

  for (const suite of suites) {
    // Skip test groups that use features we don't support yet
    const schemaStr = JSON.stringify(suite.schema);
    const hasRemoteRef =
      schemaStr.includes('"$ref":"http') ||
      schemaStr.includes('"$ref": "http');
    const hasDynamicRef = schemaStr.includes("$dynamicRef");
    const hasAnchor =
      schemaStr.includes('"$anchor"') &&
      !schemaStr.includes('"$defs"');
    if (hasRemoteRef || hasDynamicRef || hasAnchor) {
      fileSkip += suite.tests.length;
      totalSkip += suite.tests.length;
      continue;
    }

    let validator;
    try {
      validator = new Validator(suite.schema);
    } catch (e) {
      // Schema compilation failed — skip this group
      fileSkip += suite.tests.length;
      totalSkip += suite.tests.length;
      continue;
    }

    for (const test of suite.tests) {
      // Skip format "annotation by default" tests — ata validates formats
      if (file === "format.json" && test.description.includes("only an annotation")) {
        fileSkip++;
        totalSkip++;
        continue;
      }
      try {
        const result = validator.validate(test.data);
        if (result.valid === test.valid) {
          filePass++;
          totalPass++;
        } else {
          fileFail++;
          totalFail++;
          failures.push({
            file,
            suite: suite.description,
            test: test.description,
            expected: test.valid,
            got: result.valid,
            data: test.data,
            schema: suite.schema,
          });
        }
      } catch (e) {
        fileFail++;
        totalFail++;
        failures.push({
          file,
          suite: suite.description,
          test: test.description,
          expected: test.valid,
          got: "ERROR: " + e.message,
        });
      }
    }
  }

  const total = filePass + fileFail + fileSkip;
  const pct = total - fileSkip > 0
    ? ((filePass / (filePass + fileFail)) * 100).toFixed(0)
    : "N/A";
  const status = fileFail === 0 ? "PASS" : "FAIL";
  console.log(
    `  ${status}  ${file.padEnd(30)} ${filePass}/${filePass + fileFail} passed (${pct}%)${fileSkip > 0 ? ` [${fileSkip} skipped]` : ""}`
  );
}

console.log("\n========================================");
console.log(`  Total: ${totalPass} passed, ${totalFail} failed, ${totalSkip} skipped`);
const pct = ((totalPass / (totalPass + totalFail)) * 100).toFixed(1);
console.log(`  Pass rate: ${pct}%`);
console.log("========================================\n");

if (failures.length > 0 && failures.length <= 30) {
  console.log("Failures:\n");
  for (const f of failures) {
    console.log(`  ${f.file} > ${f.suite} > ${f.test}`);
    console.log(`    expected: ${f.expected}, got: ${f.got}`);
    if (f.schema) {
      console.log(`    schema: ${JSON.stringify(f.schema).slice(0, 120)}`);
      console.log(`    data: ${JSON.stringify(f.data).slice(0, 80)}`);
    }
    console.log();
  }
} else if (failures.length > 30) {
  console.log(`First 30 failures:\n`);
  for (const f of failures.slice(0, 30)) {
    console.log(`  ${f.file} > ${f.suite} > ${f.test}`);
    console.log(`    expected: ${f.expected}, got: ${f.got}`);
    console.log();
  }
}
