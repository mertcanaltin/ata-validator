'use strict';

const fs = require('fs');
const path = require('path');
const { Validator } = require('..');

const testDir = path.join(__dirname, 'json_test_suite', 'test_parsing');
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.json'));

// Simple schema that accepts any valid JSON
const v = new Validator({});

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

for (const file of files) {
  const prefix = file[0]; // y_, n_, or i_
  const filePath = path.join(testDir, file);
  const content = fs.readFileSync(filePath);

  // i_ files are implementation-defined, skip them
  if (prefix === 'i') {
    skip++;
    continue;
  }

  let accepted;
  try {
    const result = v.validateJSON(content.toString());
    accepted = result.valid;
  } catch {
    accepted = false;
  }

  const shouldAccept = prefix === 'y';

  if (accepted === shouldAccept) {
    pass++;
  } else {
    fail++;
    failures.push({
      file,
      expected: shouldAccept ? 'accept' : 'reject',
      got: accepted ? 'accepted' : 'rejected',
    });
  }
}

console.log(`\nJSONTestSuite (nst/JSONTestSuite) Results`);
console.log(`  pass: ${pass}`);
console.log(`  fail: ${fail}`);
console.log(`  skip: ${skip} (implementation-defined)`);
console.log(`  total: ${files.length}`);

if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  ${f.file}: expected ${f.expected}, got ${f.got}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
