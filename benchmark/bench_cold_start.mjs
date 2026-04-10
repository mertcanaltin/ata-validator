// Matteo's scenario: 100 route schemas, cold start comparison
// AJV normal vs AJV standalone (pre-compiled) vs ATA lazy
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { bench, group, run, summary, do_not_optimize } from "mitata";

const Ajv = require("../benchmark/node_modules/ajv");
const addFormats = require("../benchmark/node_modules/ajv-formats");
const { Validator } = require("../index.js");

// Generate realistic route schemas (like a real Fastify app)
function makeSchemas(count) {
  return Array.from({ length: count }, (_, i) => ({
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1, maxLength: 100 },
      email: { type: "string", format: "email" },
      [`field_${i}`]: { type: "string" },
      active: { type: "boolean" },
    },
    required: ["id", "name", "email"],
  }));
}

const schemas10 = makeSchemas(10);
const schemas50 = makeSchemas(50);
const schemas100 = makeSchemas(100);

const validDoc = { id: 1, name: "Mert", email: "m@x.com", field_0: "x", active: true };

// Pre-compile AJV standalone functions (simulates build-time step)
function ajvPrecompile(schemas) {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return schemas.map(s => ajv.compile(s));
}

const ajvStandalone10 = ajvPrecompile(schemas10);
const ajvStandalone50 = ajvPrecompile(schemas50);
const ajvStandalone100 = ajvPrecompile(schemas100);

// Warmup ATA cache
for (const s of schemas100) {
  const v = new Validator(s);
  v.validate(validDoc);
}

console.log("Scenario: Fastify cold start with N route schemas");
console.log("AJV normal = compile all schemas at startup");
console.log("AJV standalone = pre-compiled at build time (Matteo's blog)");
console.log("ATA = lazy compilation, no build step\n");

summary(() => {
  group("10 routes: compile + first validate", () => {
    bench("ajv normal", () => {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      for (const s of schemas10) {
        const fn = ajv.compile(s);
        do_not_optimize(fn(validDoc));
      }
    });
    bench("ajv standalone", () => {
      // Standalone: just call pre-compiled functions (no compile step)
      for (const fn of ajvStandalone10) {
        do_not_optimize(fn(validDoc));
      }
    });
    bench("ata", () => {
      for (const s of schemas10) {
        const v = new Validator(s);
        do_not_optimize(v.validate(validDoc));
      }
    });
  });

  group("50 routes: compile + first validate", () => {
    bench("ajv normal", () => {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      for (const s of schemas50) {
        const fn = ajv.compile(s);
        do_not_optimize(fn(validDoc));
      }
    });
    bench("ajv standalone", () => {
      for (const fn of ajvStandalone50) {
        do_not_optimize(fn(validDoc));
      }
    });
    bench("ata", () => {
      for (const s of schemas50) {
        const v = new Validator(s);
        do_not_optimize(v.validate(validDoc));
      }
    });
  });

  group("100 routes: compile + first validate", () => {
    bench("ajv normal", () => {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      for (const s of schemas100) {
        const fn = ajv.compile(s);
        do_not_optimize(fn(validDoc));
      }
    });
    bench("ajv standalone", () => {
      for (const fn of ajvStandalone100) {
        do_not_optimize(fn(validDoc));
      }
    });
    bench("ata", () => {
      for (const s of schemas100) {
        const v = new Validator(s);
        do_not_optimize(v.validate(validDoc));
      }
    });
  });
});

run();
