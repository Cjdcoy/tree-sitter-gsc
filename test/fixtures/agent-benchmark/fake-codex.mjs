#!/usr/bin/env node

const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex === -1 ? "success" : process.argv[scenarioIndex + 1];

if (scenario === "success") {
  process.stdout.write(
    `${JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 25,
        reasoning_output_tokens: 10
      }
    })}\n`,
  );
} else if (scenario === "malformed") {
  process.stdout.write('{"type":"turn.started"}\nnot-json\n');
} else if (scenario === "nonzero") {
  process.stderr.write("synthetic Codex failure\n");
  process.exitCode = 17;
} else if (scenario === "timeout") {
  process.on("SIGTERM", () => {});
  setInterval(() => {
    process.stdout.write('{"type":"turn.started"}\n');
  }, 20);
} else {
  process.stderr.write(`unknown fake scenario: ${scenario}\n`);
  process.exitCode = 64;
}
