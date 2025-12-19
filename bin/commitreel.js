#!/usr/bin/env node

const { runCli } = require("../src/cli");

runCli(process.argv).catch((err) => {
  console.error("commitreel: fatal error");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
