#!/usr/bin/env node
import { createProgram } from "./program.js";

createProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
