/**
 * Prerequisite handling shared by the offline checkers.
 *
 * Two checkers drive the bridge's own Python interpreter, and one of them also
 * reads the model bundle. Neither is part of a clone: the interpreter appears
 * after `uv sync` in `bridge/`, the model bundle is a download (README install
 * steps). Both are ordinary states of a fresh checkout, so a checker that cannot
 * run says what is missing and which command fixes it instead of dying in
 * `execFileSync` with a bare ENOENT.
 *
 * A checker that could not run exits with SKIP_EXIT_CODE; `check-all.mjs` counts
 * those separately from failures, and only a real failing assertion turns the
 * run red.
 */
import { join } from 'node:path';

/** Exit code a checker uses when a prerequisite is missing (not a failure). */
export const SKIP_EXIT_CODE = 77;

/**
 * Path of the bridge interpreter `uv sync` installs.
 * uv lays the environment out in `Scripts/` on Windows and `bin/` elsewhere.
 * @param {string} bridgeDir absolute path of `bridge/`
 * @returns {string} absolute path of the interpreter
 */
export function pythonPath(bridgeDir) {
  return process.platform === 'win32'
    ? join(bridgeDir, '.venv', 'Scripts', 'python.exe')
    : join(bridgeDir, '.venv', 'bin', 'python');
}

/**
 * Command that installs the bridge environment, run from the repository root.
 * `;` instead of `&&` because Windows PowerShell 5 does not accept `&&`.
 * @returns {string} one copyable line
 */
export function venvCommand() {
  return process.platform === 'win32' ? 'cd bridge; uv sync' : 'cd bridge && uv sync';
}

/**
 * Command that regenerates `core/models/keywords.txt` from the wake words in
 * `config.py`, the same entry point the bridge runs on startup
 * (`bridge/main.py` -> `core/services/audio/kws/keywords.py`). Needs the
 * tokenizer files (`tokens.txt`, `bpe.model`) to be in place already.
 * @returns {string} one copyable line, run from the repository root
 */
export function keywordGeneratorCommand() {
  return process.platform === 'win32'
    ? "cd bridge; $env:DSH_ENABLE='1'; .\\.venv\\Scripts\\python.exe core\\services\\audio\\kws\\keywords.py"
    : 'cd bridge && DSH_ENABLE=1 .venv/bin/python core/services/audio/kws/keywords.py';
}

/**
 * Report why a check could not run and stop with SKIP_EXIT_CODE.
 * @param {{problem: string, fixes: string[]}[]} entries one entry per missing prerequisite
 * @returns {never}
 */
export function skip(entries) {
  for (const { problem, fixes } of entries) {
    console.log(`  skip   ${problem}`);
    for (const fix of fixes) console.log(`         fix: ${fix}`);
  }
  console.log('  skip   the check did not run; this is not counted as a failure (exit 77)');
  process.exit(SKIP_EXIT_CODE);
}
