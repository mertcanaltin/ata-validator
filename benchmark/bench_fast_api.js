const { bench, group, run, summary } = require("mitata");
const { Validator } = require("../index");

const native = require("node-gyp-build")(__dirname + "/..");

const schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    age: { type: "integer", minimum: 0, maximum: 150 },
    active: { type: "boolean" },
  },
  required: ["id", "name", "email", "active"],
};

const smallDoc = { id: 42, name: "Mert", email: "m@e.com", active: true };
const smallBuf = Buffer.from(JSON.stringify(smallDoc));
const smallStr = JSON.stringify(smallDoc);

// Large: 100-item array
const largeSchema = {
  type: "array",
  items: schema,
  maxItems: 200,
};
const largeDoc = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  name: `User ${i}`,
  email: `u${i}@e.com`,
  active: i % 2 === 0,
}));
const largeBuf = Buffer.from(JSON.stringify(largeDoc));

const v = new Validator(schema);
const vLarge = new Validator(largeSchema);

// Warm up — ensure TurboFan optimizes the CFunction path
for (let i = 0; i < 10000; i++) {
  v.isValid(smallBuf);
  v.isValidJSON(smallStr);
}
for (let i = 0; i < 1000; i++) {
  vLarge.isValid(largeBuf);
}

// --- Single document ---
summary(() => {
  group("Small payload (5 fields) - validation", () => {
    bench("isValid (V8 CFunction)", () => v.isValid(smallBuf));
    bench("isValidJSON (NAPI)", () => v.isValidJSON(smallStr));
    bench("rawFastValidate (raw NAPI)", () =>
      native.rawFastValidate(v._fastSlot, smallBuf),
    );
    bench("JSON.parse only", () => JSON.parse(smallStr));
    bench("isValid + JSON.parse", () => {
      v.isValid(smallBuf);
      JSON.parse(smallStr);
    });
  });
});

summary(() => {
  group("Large payload (100 items) - validation", () => {
    bench("isValid (V8 CFunction)", () => vLarge.isValid(largeBuf));
    bench("isValidJSON (NAPI)", () =>
      vLarge.isValidJSON(JSON.stringify(largeDoc)),
    );
  });
});

// --- NDJSON ---
const ndjsonLines = Array.from({ length: 1000 }, (_, i) =>
  JSON.stringify({
    id: i + 1,
    name: `U${i}`,
    email: `u${i}@e.com`,
    active: true,
  }),
);
const ndjsonBuf = Buffer.from(ndjsonLines.join("\n") + "\n");

// Warm up
for (let i = 0; i < 100; i++) v.countValid(ndjsonBuf);

summary(() => {
  group("NDJSON 1000 documents", () => {
    bench("countValid (V8 CFunction)", () => v.countValid(ndjsonBuf));
    bench("rawNDJSONValidate (NAPI)", () =>
      native.rawNDJSONValidate(v._fastSlot, ndjsonBuf),
    );
    bench("rawParallelCount (NAPI threads)", () =>
      native.rawParallelCount(v._fastSlot, ndjsonBuf),
    );
  });
});

// --- Batch ---
const batchBufs = ndjsonLines.slice(0, 100).map((l) => Buffer.from(l));

// Warm up
for (let i = 0; i < 100; i++) v.batchIsValid(batchBufs);

summary(() => {
  group("Batch 100 documents", () => {
    bench("batchIsValid (V8 CFunction)", () => v.batchIsValid(batchBufs));
    bench("rawBatchValidate (NAPI)", () =>
      native.rawBatchValidate(v._fastSlot, batchBufs),
    );
  });
});

run();
