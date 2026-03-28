import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Resolve a bare model name to its full file path within the .models directory.
 * Handles the subdirectory-based storage layout where each model lives in its own folder.
 *
 * Resolution order:
 * 1. If name contains '/' or '\' → treat as a relative path under modelsDir
 * 2. Append .gguf if missing, then scan modelsDir subdirectories for a match
 * 3. Fall back to modelsDir/name (backward compat with pre-migration flat layout)
 */
export async function resolveModelFile(modelsDir: string, modelName: string): Promise<string> {
  // Already a relative path — resolve directly
  if (modelName.includes('/') || modelName.includes('\\')) {
    return path.join(modelsDir, modelName);
  }

  const fileName = modelName.endsWith('.gguf') ? modelName : `${modelName}.gguf`;

  // Scan subdirectories for the file
  try {
    const entries = await fs.readdir(modelsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(modelsDir, entry.name, fileName);
      try {
        await fs.stat(candidate);
        return candidate;
      } catch { /* not in this dir */ }
    }
  } catch { /* modelsDir may not exist yet */ }

  // Backward compat: file at root
  return path.join(modelsDir, fileName);
}
