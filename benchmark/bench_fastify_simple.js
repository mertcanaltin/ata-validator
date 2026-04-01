#!/usr/bin/env node
/**
 * Clean Fastify pipeline benchmark: AJV vs ata-validator
 * Uses separate autocannon runs for valid and invalid payloads
 */
const { Validator } = require("../index");
const autocannon = require("autocannon");

const DURATION = 5;
const CONNECTIONS = 10;
const PIPELINING = 10;

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

const validBody = JSON.stringify({
  id: 42, name: "Mert Can Altin", email: "mert@example.com", age: 26, active: true,
});
const invalidBody = JSON.stringify({ id: -1, name: "", email: "bad", active: "yes" });

function run(port, body, title) {
  return new Promise((resolve) => {
    autocannon({
      url: `http://127.0.0.1:${port}/validate`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duration: DURATION,
      connections: CONNECTIONS,
      pipelining: PIPELINING,
    }, (err, result) => {
      console.log(`  ${title}`);
      console.log(`    ${result.requests.average.toLocaleString()} req/s avg | ${result.latency.average.toFixed(2)}ms avg | ${result.latency.p99.toFixed(2)}ms p99`);
      resolve(result);
    });
  });
}

async function main() {
  const Fastify = require("fastify");

  // --- AJV Server ---
  const ajv = Fastify({ logger: false });
  ajv.post("/validate", {
    schema: { body: schema },
  }, async () => ({ ok: true }));
  await ajv.listen({ port: 3001, host: "127.0.0.1" });

  // --- ata Server ---
  const ata = Fastify({ logger: false });
  ata.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => done(null, body));
  const validator = new Validator(schema);
  ata.post("/validate", async (req, reply) => {
    if (!validator.isValid(req.body)) { reply.code(400); return { ok: false }; }
    return { ok: true, data: JSON.parse(req.body) };
  });
  await ata.listen({ port: 3002, host: "127.0.0.1" });

  console.log("\nFastify Pipeline Benchmark");
  console.log("=".repeat(60));
  console.log(`${DURATION}s per test, ${CONNECTIONS} connections, ${PIPELINING} pipelining\n`);

  // Warm up
  await run(3001, validBody, "warmup"); await run(3002, validBody, "warmup");
  console.log("");

  // Valid payload
  console.log("Valid payload (parse + validate + respond):");
  const ajvValid = await run(3001, validBody, "Fastify + AJV");
  const ataValid = await run(3002, validBody, "Fastify + ata");
  console.log(`  -> ata is ${(ataValid.requests.average / ajvValid.requests.average).toFixed(2)}x throughput\n`);

  // Invalid payload
  console.log("Invalid payload (reject as fast as possible):");
  const ajvInvalid = await run(3001, invalidBody, "Fastify + AJV");
  const ataInvalid = await run(3002, invalidBody, "Fastify + ata");
  console.log(`  -> ata is ${(ataInvalid.requests.average / ajvInvalid.requests.average).toFixed(2)}x throughput\n`);

  // Summary
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  Valid:   AJV ${ajvValid.requests.average.toLocaleString()} req/s vs ata ${ataValid.requests.average.toLocaleString()} req/s`);
  console.log(`  Invalid: AJV ${ajvInvalid.requests.average.toLocaleString()} req/s vs ata ${ataInvalid.requests.average.toLocaleString()} req/s`);
  console.log(`  Valid p99:   AJV ${ajvValid.latency.p99.toFixed(2)}ms vs ata ${ataValid.latency.p99.toFixed(2)}ms`);
  console.log(`  Invalid p99: AJV ${ajvInvalid.latency.p99.toFixed(2)}ms vs ata ${ataInvalid.latency.p99.toFixed(2)}ms`);

  await ajv.close();
  await ata.close();
}

main().catch(console.error);
