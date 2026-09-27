// Compares a Vitest JSON report against a baseline of known failures.
// Usage: node compare-failures.cjs <vitest-report.json> <baseline.txt>
// Exit 0 = no failures beyond the baseline; otherwise prints each NEW failure and exits 1.
// A test file that fails without any failed assertion (e.g. an import error) counts as
// "<file> :: (file failed to load)".
const fs = require('fs');

const [reportPath, baselinePath] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const failed = [];
let passed = 0;
for (const s of report.testResults) {
  const file = s.name.replace(/.*__tests__[\\/]/, '');
  let fileAssertionFailed = false;
  for (const a of s.assertionResults) {
    if (a.status === 'failed') {
      fileAssertionFailed = true;
      failed.push(`${file} :: ${a.fullName}`);
    }
    if (a.status === 'passed') passed++;
  }
  if (s.status === 'failed' && !fileAssertionFailed) failed.push(`${file} :: (file failed to load)`);
}
const base = new Set(fs.readFileSync(baselinePath, 'utf8').split('\n').filter(Boolean));
const fresh = failed.filter((f) => !base.has(f));
console.log(
  `passed ${passed}, failed ${failed.length} (baseline ${base.size}), new failures ${fresh.length}`,
);
for (const f of fresh) console.log(`NEW FAIL: ${f}`);
process.exit(fresh.length ? 1 : 0);
