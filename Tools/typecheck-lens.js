#!/usr/bin/env node
/**
 * Tools/typecheck-lens.js
 * -----------------------------------------------------------------------------
 * Type-check Scripts/*.ts against Snap's REAL Lens Studio API.
 *
 * CI checks the subsystems against types/lens-studio.d.ts, which is hand-written
 * - a green there means "consistent with our own guesses". This check uses the
 * declaration file Lens Studio itself generates (StudioLib.d.ts, ~34k lines,
 * every class in the runtime) plus the base declarations shipped inside the app
 * bundle, compiled with the same options Lens Studio uses for projects
 * (es2021, commonjs, isolatedModules, standard decorators).
 *
 * It needs Lens Studio installed and launched at least once on this machine, so
 * it is a local gate, not a CI step. Snap's declaration files are not ours to
 * commit.
 *
 * The SpectaclesInteractionKit import is shimmed: SIK is a package added to a
 * project, not part of StudioLib, so only its entry point is stubbed here.
 *
 * Usage: node Tools/typecheck-lens.js        (or: npm run typecheck:lens)
 * License: Apache-2.0
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOME = os.homedir();
const STUDIO_LIB = path.join(HOME, "Library/Caches/Snap/Lens Studio/DtsCache/StudioLib.d.ts");
const APP_DECL = [
  "/Applications/Lens Studio.app",
  path.join(HOME, "Applications/Lens Studio.app"),
].map((a) => path.join(a, "Contents/Plugins/Es_TypeScriptCompilationManager.bundle/TypeScript/lib/LensifyTS/Declarations"))
 .find((p) => fs.existsSync(p));

if (!fs.existsSync(STUDIO_LIB) || !APP_DECL) {
  console.error("typecheck:lens - Lens Studio's declarations were not found on this machine.");
  console.error("  needs: " + STUDIO_LIB);
  console.error("  and:   <Lens Studio.app>/Contents/Plugins/Es_TypeScriptCompilationManager.bundle/.../Declarations");
  console.error("  Install Lens Studio 5.22+ and launch it once; it generates StudioLib.d.ts on start.");
  process.exit(2);
}

const root = path.resolve(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "spatialis-lens-"));
const decl = path.join(work, "decl");
fs.mkdirSync(decl);
for (const f of fs.readdirSync(APP_DECL).filter((f) => f.endsWith(".d.ts"))) {
  fs.copyFileSync(path.join(APP_DECL, f), path.join(decl, f));
}
fs.copyFileSync(STUDIO_LIB, path.join(decl, "StudioLib.d.ts"));

// SIK ships as a project package, not in StudioLib. When a Lens Studio project
// in this repo has compiled once, its cache holds the package's real TypeScript
// source - use that, so the gesture controller is checked against the actual
// TrackedHand API. Otherwise fall back to a minimal shim of the entry point.
const projectSik = fs.readdirSync(root)
  .map((d) => path.join(root, d, "Cache/TypeScript/Src/Packages/SpectaclesInteractionKit.lspkg"))
  .find((p) => fs.existsSync(path.join(p, "SIK.ts")));
let packagesDir;
if (projectSik) {
  packagesDir = path.dirname(projectSik);
} else {
  packagesDir = path.join(work, "Packages");
  const sik = path.join(packagesDir, "SpectaclesInteractionKit.lspkg");
  fs.mkdirSync(sik, { recursive: true });
  fs.writeFileSync(
    path.join(sik, "SIK.ts"),
    '// Shim for the real-API type check only: no Lens Studio project cache was found.\n' +
    'export declare const SIK: { HandInputData: { getHand(side: "left" | "right"): any } };\n'
  );
}

const scripts = fs.readdirSync(path.join(root, "Scripts")).filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(root, "Scripts", f));
const tsconfig = {
  compilerOptions: {
    module: "commonjs", target: "es2021", lib: ["es2021"], isolatedModules: true,
    noEmit: true, skipDefaultLibCheck: true, skipLibCheck: true, types: [],
    baseUrl: packagesDir, paths: { "*": ["./*"] },
  },
  files: [...fs.readdirSync(decl).map((f) => path.join(decl, f)), ...scripts],
};
fs.writeFileSync(path.join(work, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

const version = (() => {
  try {
    const plist = fs.readFileSync(path.join(APP_DECL, "../../../../../../Info.plist"), "utf8");
    const m = /CFBundleShortVersionString<\/key>\s*<string>([^<]+)</.exec(plist);
    return m ? m[1] : "unknown";
  } catch { return "unknown"; }
})();
const lines = fs.readFileSync(STUDIO_LIB, "utf8").split("\n").length;
console.log(`typecheck:lens - Lens Studio ${version}, StudioLib.d.ts (${lines.toLocaleString()} lines), ${scripts.length} scripts, SIK: ${projectSik ? "real package source" : "shim"}`);

const tsc = path.join(root, "node_modules", ".bin", "tsc");
const r = spawnSync(tsc, ["-p", path.join(work, "tsconfig.json")], { encoding: "utf8" });
const out = (r.stdout || "") + (r.stderr || "");
const errors = out.split("\n").filter((l) => /error TS/.test(l)).map((l) => l.replace(root + path.sep, ""));
fs.rmSync(work, { recursive: true, force: true });

if (errors.length) {
  console.log(errors.join("\n"));
  console.log(`\n${errors.length} error(s) against the real Lens Studio API.`);
  process.exit(1);
}
console.log("clean - every subsystem type-checks against the real Lens Studio API.");
