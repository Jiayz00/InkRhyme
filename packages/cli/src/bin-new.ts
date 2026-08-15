#!/usr/bin/env node

import { runProgram } from "./program.js";

// inkos-new bin entrypoint — transparently runs `inkos new` with argv shifted.
// Keeps backward compatibility with the user's legacy `inkos-new.cmd` workflow
// while the real implementation lives as a commander subcommand.
const argv = ["inkos", "new", ...process.argv.slice(2)];
await runProgram(argv);
