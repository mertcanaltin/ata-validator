// Cold-path benchmark: measures `new Validator(schema) + isValidObject(data)` total time.
// Target (M1): S1 < 1.5μs, S2 < 2μs.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { bench, group, run, summary } from "mitata";

const Ajv = require("./node_modules/ajv");
const { Validator } = require("../index.js");

const schemas = {
  S1: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      active: { type: "boolean" },
    },
    required: ["id", "name"],
  },
  S2: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1, maxLength: 100 },
      email: { type: "string" },
      age: { type: "integer", minimum: 0, maximum: 150 },
      role: { type: "string", enum: ["admin", "user", "guest"] },
      active: { type: "boolean" },
      score: { type: "number", minimum: 0, maximum: 100 },
      tag: { type: "string", maxLength: 20 },
      createdAt: { type: "string" },
      flags: { type: "string" },
    },
    required: ["id", "name", "email"],
  },
};

const payloads = {
  S1: { id: 1, name: "alice", active: true },
  S2: {
    id: 1,
    name: "alice",
    email: "a@b.com",
    age: 30,
    role: "user",
    active: true,
    score: 95.5,
    tag: "t1",
    createdAt: "2026-04-16",
    flags: "x",
  },
};

const _ajvInit = new Ajv();
const _ajvS1 = _ajvInit.compile(schemas.S1);
const _ajvS2 = _ajvInit.compile(schemas.S2);

// Pre-generate a pool of fresh schema object instances to defeat identity-cache hits.
// Each bench call pulls a fresh object from the pool so ata can't reuse a cached validator.
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
const POOL = 5000;
const freshS1 = Array.from({ length: POOL }, () => clone(schemas.S1));
const freshS2 = Array.from({ length: POOL }, () => clone(schemas.S2));
let i1 = 0, i2 = 0;

group("S1 warm-cached: construct + 1 validate (same schema object reused)", () => {
  summary(() => {
    bench("ata (this)", () => {
      const v = new Validator(schemas.S1);
      return v.isValidObject(payloads.S1);
    });
    bench("ajv compile + validate", () => {
      const ajv = new Ajv();
      const v = ajv.compile(schemas.S1);
      return v(payloads.S1);
    });
    bench("ajv precompiled (baseline)", () => {
      return _ajvS1(payloads.S1);
    });
  });
});

group("S2 warm-cached: 10 props with enum/format", () => {
  summary(() => {
    bench("ata (this)", () => {
      const v = new Validator(schemas.S2);
      return v.isValidObject(payloads.S2);
    });
    bench("ajv compile + validate", () => {
      const ajv = new Ajv();
      const v = ajv.compile(schemas.S2);
      return v(payloads.S2);
    });
    bench("ajv precompiled (baseline)", () => {
      return _ajvS2(payloads.S2);
    });
  });
});

group("S1 TRUE COLD: fresh schema each iteration", () => {
  summary(() => {
    bench("ata (this) fresh-schema", () => {
      const s = freshS1[(i1++) % POOL];
      const v = new Validator(s);
      return v.isValidObject(payloads.S1);
    });
    bench("ajv compile+validate fresh", () => {
      const s = freshS1[(i1++) % POOL];
      const ajv = new Ajv();
      const v = ajv.compile(s);
      return v(payloads.S1);
    });
  });
});

group("S2 TRUE COLD: fresh schema each iteration", () => {
  summary(() => {
    bench("ata (this) fresh-schema", () => {
      const s = freshS2[(i2++) % POOL];
      const v = new Validator(s);
      return v.isValidObject(payloads.S2);
    });
    bench("ajv compile+validate fresh", () => {
      const s = freshS2[(i2++) % POOL];
      const ajv = new Ajv();
      const v = ajv.compile(s);
      return v(payloads.S2);
    });
  });
});

await run();
