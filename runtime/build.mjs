// Reproducible build of the signed runtime (RUN-001). W3's release workflow runs
// `npm ci --ignore-scripts && npm run build` in two clean copies of the mirrored tree
// and signs runtime/dist/runtime.mjs only when both builds are byte-identical. So the
// output carries no timestamp, no absolute path, no sourcemap and no legal comments.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/runtime.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  charset: "utf8",
  minify: false,
  logLevel: "warning",
  // Module paths in the output stay relative to this directory even when node_modules is a link.
  preserveSymlinks: true,
  // Bundled CommonJS dependencies (yaml) call require() for node builtins; ESM has none.
  banner: {
    js: [
      `// BenchRouter runtime ${pkg.version} (protocol ${pkg.benchrouter.protocol_major}). Built from BenchRouter/runtime.`,
      'import { createRequire as __benchrouterCreateRequire } from "node:module";',
      "const require = __benchrouterCreateRequire(import.meta.url);"
    ].join("\n")
  },
  define: { "process.env.NODE_ENV": '"production"' }
});
