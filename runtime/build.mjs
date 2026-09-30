// Placeholder build. The mirrored runtime replaces this file with its own build.
// Contract with the release workflow: `npm run build` writes one self-contained
// file to dist/runtime.mjs, and two builds of the same commit are byte-identical.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/runtime.mjs", "dist/runtime.mjs");
