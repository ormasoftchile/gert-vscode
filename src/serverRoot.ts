import * as fs from 'fs';
import * as path from 'path';

function hasDirectory(dir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

function isGertProjectRoot(dir: string): boolean {
  const hasRunbooks = hasDirectory(dir, 'runbooks');
  if (hasDirectory(dir, 'packages') && hasRunbooks) return true;

  // A generic directory named "tools" (for example C:\tools) is not a Gert
  // project. Legacy Gert projects need either sibling runbooks or .gert config.
  return hasDirectory(dir, 'tools')
    && (hasRunbooks || fs.existsSync(path.join(dir, '.gert')));
}

function findGertProjectRoot(start: string): string | undefined {
  let dir = start;
  while (true) {
    if (isGertProjectRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// pickServerRoot chooses the narrowest Gert project root for the active
// runbook. Falling back to a broad workspace makes `gert serve` discover tool
// definitions from unrelated projects, allowing duplicate tool names to win.
export function pickServerRoot(
  runbookPath: string,
  workspaceFolders: readonly string[],
  fallback: string,
): string {
  const fromRunbook = findGertProjectRoot(path.dirname(runbookPath));
  if (fromRunbook) return fromRunbook;

  for (const folder of workspaceFolders) {
    const fromWorkspace = findGertProjectRoot(folder);
    if (fromWorkspace) return fromWorkspace;
  }

  return path.dirname(runbookPath) || workspaceFolders[0] || fallback;
}
