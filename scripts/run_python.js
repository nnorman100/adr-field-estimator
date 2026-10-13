// Runs a Python script under whichever interpreter the machine has: `python` (Windows), `python3`
// (Linux, WSL, macOS) or the Windows `py` launcher. Used by the Hosting predeploy hook in firebase.json,
// which the Firebase CLI runs through cmd.exe or /bin/sh, so it cannot assume one interpreter name.
// Arguments and the exit code pass through; no interpreter at all fails, so the guard is never skipped.
const { spawnSync } = require('node:child_process');
for (const python of ['python', 'python3', 'py']) {
  const result = spawnSync(python, process.argv.slice(2), { stdio: 'inherit' });
  if (result.error && result.error.code === 'ENOENT') continue;
  if (result.error) {
    console.error(`Could not run ${python}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}
console.error(
  'No Python interpreter found (tried python, python3, py); install Python 3 and retry.',
);
process.exit(1);
