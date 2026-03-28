# Contributing to ata-validator

Thanks for your interest. Here's how to get started.

## Setup

```bash
git clone https://github.com/ata-core/ata-validator.git
cd ata-validator
npm install
npm run build
```

## Running Tests

Before submitting a PR, make sure everything passes:

```bash
# All tests
node tests/test_lazy.js
node tests/test_dual_path.js
node tests/test_standard_schema.js
node tests/test_compat.js
node tests/run_suite.js

# Quick check
npm test
```

The JSON Schema Test Suite should show 937+ passed with 98.6%+ pass rate.

## Running Benchmarks

```bash
node benchmark/bench_vs_ajv.js
```

If your change affects performance, include before/after numbers in the PR description. We care about:
- validate(obj) valid/invalid ops/sec
- isValidObject ops/sec
- Constructor and first validation time
- No regressions on any metric

## How We Work

**Profile first, optimize second.** We use Daniel Lemire's approach: measure each part, find the bottleneck, fix it, measure again. Don't guess where the slowness is.

**Test before and after.** Every optimization should have numbers. "I think this is faster" is not enough.

**Keep it simple.** If you can get 80% of the gain with 20% of the complexity, do that. We prefer readable code over clever tricks.

**Don't break the API.** `new Validator(schema)`, `validate()`, `isValidObject()`, `toStandalone()` should keep working exactly as before.

## What We're Looking For

- Performance improvements with benchmark proof
- Spec compliance fixes (the remaining 13 failing tests in run_suite.js)
- Bug fixes with test cases
- Documentation improvements

## What to Avoid

- Breaking changes to the public API
- Adding dependencies (we keep the dep count minimal)
- Cosmetic refactors without functional improvement
- Benchmark numbers without methodology (always share the code and how you measured)

## Code Style

No strict linter. Just match the existing style. Single quotes in the C++ side, double quotes in JS side are fine.

## PR Process

1. Fork and branch from `master`
2. Make your change
3. Run all tests
4. Run benchmarks if performance-related
5. Open a PR with a clear description of what and why

We review quickly. Small focused PRs are easier to review than large ones.

## Questions?

Open an issue or reach out to [@mecaltin](https://x.com/mecaltin).
