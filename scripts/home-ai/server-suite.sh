#!/usr/bin/env bash
# Runs the fork's full server Vitest suite with a throwaway home (upstream tests
# otherwise read/write the real %USERPROFILE%\.claude and .pixel-agents on Windows)
# and compares failures against the recorded Windows baseline.
# Exit 0 = no failures beyond baseline. Prints NEW failures otherwise.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
export USERPROFILE="$(cygpath -w "$T")" HOME="$T"
cd "$HERE/../../server" || exit 2
npx vitest run --reporter=json --outputFile="$T/r.json" >/dev/null 2>&1
node -e '
const r = require(process.argv[1]);
const fs = require("fs");
const failed = [];
let passed = 0;
for (const s of r.testResults) for (const a of s.assertionResults) {
  if (a.status === "failed") failed.push(s.name.replace(/.*__tests__[\\/]/, "") + " :: " + a.fullName);
  if (a.status === "passed") passed++;
}
const base = new Set(fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean));
const fresh = failed.filter((f) => !base.has(f));
console.log(`passed ${passed}, failed ${failed.length} (baseline ${base.size}), new failures ${fresh.length}`);
for (const f of fresh) console.log("NEW FAIL: " + f);
process.exit(fresh.length ? 1 : 0);
' "$T/r.json" "$HERE/server-baseline-failures.txt"
code=$?
rm -rf "$T"
exit $code
