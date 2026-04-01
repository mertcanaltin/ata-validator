#!/usr/bin/env node
/**
 * Real-world HTTP pipeline benchmark: Fastify + AJV vs Fastify + ata
 *
 * Tests the full request validation pipeline with realistic traffic mix:
 * - 30% valid requests (parse + validate + handle)
 * - 70% invalid requests (reject as fast as possible)
 *
 * This simulates production API traffic where most requests under load
 * are malformed, rate-limited, or from bad actors.
 */

const { Validator } = require("../index");
const autocannon = require("autocannon");

const DURATION = 10; // seconds per test
const CONNECTIONS = 2;
const PORT_AJV = 3001;
const PORT_ATA = 3002;

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

// 30% valid, 70% invalid payloads
const validPayload = JSON.stringify({
  id: 42,
  name: "Mert Can Altin",
  email: "mert@example.com",
  age: 26,
  active: true,
});

const invalidPayloads = [
  JSON.stringify({ id: -1, name: "", email: "bad", active: "yes" }), // type + constraint violations
  JSON.stringify({ name: "missing id" }), // missing required
  JSON.stringify({ id: "wrong_type", name: "x", email: "a@b.c", active: true }), // wrong type
  '{"broken json', // malformed JSON
  JSON.stringify({ id: 1 }), // missing required fields
  JSON.stringify({ id: 0, name: "x", email: "x@y.z", active: true }), // minimum violation
  JSON.stringify({ id: 1, name: "", email: "x@y.z", active: true }), // minLength violation
];

function buildRequestBodies(validRatio = 0.3) {
  // Build a pool of 1000 requests with the specified valid/invalid ratio
  const bodies = [];
  for (let i = 0; i < 1000; i++) {
    if (Math.random() < validRatio) {
      bodies.push(validPayload);
    } else {
      bodies.push(invalidPayloads[i % invalidPayloads.length]);
    }
  }
  return bodies;
}

async function startAjvServer() {
  const Fastify = require("fastify");
  const app = Fastify({ logger: false });

  // AJV is Fastify's default validator — just use schema option
  app.post(
    "/validate",
    {
      schema: {
        body: schema,
        response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } },
      },
    },
    async (req) => ({ ok: true }),
  );

  await app.listen({ port: PORT_AJV, host: "127.0.0.1" });
  return app;
}

async function startAtaServer() {
  const Fastify = require("fastify");
  const app = Fastify({
    logger: false,
    // Disable default AJV validation for this route
  });

  // Need raw body for buffer-based validation
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      done(null, body);
    },
  );

  const validator = new Validator(schema);

  app.post("/validate", async (req, reply) => {
    const buf = req.body;
    if (!validator.isValid(buf)) {
      reply.code(400);
      return { ok: false };
    }
    // Only parse if valid — the key optimization
    const data = JSON.parse(buf);
    return { ok: true };
  });

  await app.listen({ port: PORT_ATA, host: "127.0.0.1" });
  return app;
}

function runBenchmark(port, title, bodies) {
  return new Promise((resolve) => {
    let bodyIdx = 0;
    const instance = autocannon(
      {
        url: `http://127.0.0.1:${port}/validate`,
        method: "POST",
        headers: { "content-type": "application/json" },
        duration: DURATION,
        connections: CONNECTIONS,
        pipelining: 1,
        requests: bodies.map((b) => ({
          method: "POST",
          path: "/validate",
          headers: { "content-type": "application/json" },
          body: b,
        })),
      },
      (err, result) => {
        if (err) console.error(err);
        resolve(result);
      },
    );
  });
}

function printResult(title, result) {
  console.log(`\n  ${title}`);
  console.log(`  ${"─".repeat(50)}`);
  console.log(
    `  Req/s:     ${result.requests.average.toLocaleString()} avg (${result.requests.min.toLocaleString()} min, ${result.requests.max.toLocaleString()} max)`,
  );
  console.log(
    `  Latency:   ${result.latency.average.toFixed(2)}ms avg, ${result.latency.p99.toFixed(2)}ms p99`,
  );
  console.log(
    `  Throughput: ${(result.throughput.average / 1024 / 1024).toFixed(1)} MB/s`,
  );
  console.log(`  Total:     ${result.requests.total.toLocaleString()} requests`);
  console.log(
    `  Errors:    ${result.errors} connection errors, ${result.non2xx} non-2xx`,
  );
}

async function main() {
  console.log("\nFastify Pipeline Benchmark: AJV vs ata-validator");
  console.log("=".repeat(55));
  console.log(`Duration: ${DURATION}s per test, ${CONNECTIONS} connections`);
  console.log("Traffic mix: 30% valid, 70% invalid requests\n");

  const bodies = buildRequestBodies(0.3);

  // Start both servers
  const ajvApp = await startAjvServer();
  const ataApp = await startAtaServer();

  // Warm up
  console.log("Warming up...");
  await runBenchmark(PORT_AJV, "", bodies);
  await runBenchmark(PORT_ATA, "", bodies);

  // Real benchmarks
  console.log("\nRunning benchmarks...");

  const ajvResult = await runBenchmark(PORT_AJV, "AJV", bodies);
  printResult("Fastify + AJV (default)", ajvResult);

  const ataResult = await runBenchmark(PORT_ATA, "ata", bodies);
  printResult("Fastify + ata-validator", ataResult);

  // Comparison
  const speedup = ataResult.requests.average / ajvResult.requests.average;
  const latencyImprovement =
    ajvResult.latency.average / ataResult.latency.average;
  const p99Improvement = ajvResult.latency.p99 / ataResult.latency.p99;

  console.log("\n  Comparison");
  console.log(`  ${"─".repeat(50)}`);
  console.log(`  Throughput: ata is ${speedup.toFixed(2)}x faster`);
  console.log(
    `  Avg latency: ata is ${latencyImprovement.toFixed(2)}x lower`,
  );
  console.log(`  p99 latency: ata is ${p99Improvement.toFixed(2)}x lower`);

  if (speedup > 1) {
    console.log(
      `\n  ata handles ${((speedup - 1) * 100).toFixed(0)}% more requests per second.`,
    );
  }

  await ajvApp.close();
  await ataApp.close();
}

main().catch(console.error);
