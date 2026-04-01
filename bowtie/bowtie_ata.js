const readline = require("readline");
const { Validator } = require("ata-validator");
const os = require("os");

const rl = readline.createInterface({ input: process.stdin });

let currentDialect = "https://json-schema.org/draft/2020-12/schema";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  const cmd = JSON.parse(line);

  if (cmd.cmd === "start") {
    send({
      version: 1,
      implementation: {
        language: "javascript",
        name: "ata-validator",
        version: require("ata-validator/package.json").version,
        homepage: "https://ata-validator.com",
        documentation: "https://github.com/mertcanaltin/ata",
        issues: "https://github.com/mertcanaltin/ata/issues",
        source: "https://github.com/mertcanaltin/ata",
        dialects: [
          "https://json-schema.org/draft/2020-12/schema",
          "http://json-schema.org/draft-07/schema#",
        ],
        os: os.platform(),
        os_version: os.release(),
        language_version: process.version,
      },
    });
  } else if (cmd.cmd === "dialect") {
    currentDialect = cmd.dialect;
    send({ ok: true });
  } else if (cmd.cmd === "run") {
    try {
      const testCase = cmd.case;
      const registry = testCase.registry || {};

      // Build schemas array from registry
      const schemas = [];
      for (const [uri, schema] of Object.entries(registry)) {
        schemas.push({ ...schema, $id: uri });
      }

      const v = new Validator(testCase.schema, {
        schemas: schemas.length > 0 ? schemas : undefined,
      });

      const results = [];
      for (const test of testCase.tests) {
        try {
          const result = v.validate(test.instance);
          results.push({ valid: result.valid });
        } catch (e) {
          results.push({
            errored: true,
            context: { message: e.message },
          });
        }
      }

      send({ seq: cmd.seq, results });
    } catch (e) {
      send({
        seq: cmd.seq,
        errored: true,
        context: { message: e.message, traceback: e.stack },
      });
    }
  } else if (cmd.cmd === "stop") {
    process.exit(0);
  }
});
