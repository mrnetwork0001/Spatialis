/**
 * Tools/patch-build.js
 * -----------------------------------------------------------------------------
 * Post-processes TypeScript output so it can be loaded outside Lens Studio.
 *
 * Two things Lens Studio does for us that neither Node nor a browser will:
 *   esm - browsers require a file extension on relative specifiers; tsc emits
 *         them exactly as written in the source, which has none.
 *   cjs - "SpectaclesInteractionKit.lspkg/SIK" is a Lens Studio package
 *         specifier that resolves to nothing under Node, so it is redirected
 *         to the test stub.
 *
 * Usage: node Tools/patch-build.js --mode=esm|cjs --dir=<outDir>
 * License: Apache-2.0
 */

const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);

const mode = args.mode;
const dir = args.dir;
if (!mode || !dir) {
  console.error("usage: node Tools/patch-build.js --mode=esm|cjs --dir=<outDir>");
  process.exit(2);
}

const SIK_SPECIFIER = "SpectaclesInteractionKit.lspkg/SIK";

function walk(d, out = []) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

let patched = 0;
for (const file of walk(dir)) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;

  if (mode === "esm") {
    after = after.replace(/(from\s+")(\.\/[^"]+?)(")/g, (m, a, spec, c) =>
      a + spec + (spec.endsWith(".js") ? "" : ".js") + c
    );
  } else {
    // Point the Lens Studio package specifier at the controllable test stub.
    const rel = path
      .relative(path.dirname(file), path.join(process.cwd(), "Tests", "stubs", "SIK.js"))
      .split(path.sep)
      .join("/");
    after = after.split(`"${SIK_SPECIFIER}"`).join(`"${rel.startsWith(".") ? rel : "./" + rel}"`);
  }

  if (after !== before) {
    fs.writeFileSync(file, after);
    patched++;
  }
}

if (mode === "esm") {
  // Stamp the bundle with the commit it was built from, so the simulator's
  // header shows which code is loaded - a stale cached module looks exactly
  // like a real failure otherwise. Lives in the (gitignored) bundle dir, so
  // it can never lag behind the source the way a hand-edited constant did.
  // Hosts that build from a clone often strip .git, so take the commit from the
  // environment when they offer it and only shell out to git as a fallback.
  let sha = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "").slice(0, 7);
  if (!sha) {
    try {
      sha = require("child_process").execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch (e) { /* not a git checkout */ }
  }
  if (!sha) sha = "dev";
  fs.writeFileSync(path.join(dir, "build-id.js"), `export const BUILD = ${JSON.stringify(sha)};\n`);
  console.log(`patch-build(esm): stamped build-id.js = ${sha}`);
}
console.log(`patch-build(${mode}): rewrote ${patched} file(s) in ${dir}`);
