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
node "$HERE/compare-failures.cjs" "$T/r.json" "$HERE/server-baseline-failures.txt"
code=$?
rm -rf "$T"
exit $code
