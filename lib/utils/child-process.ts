/**
 * Wrapper around Node's child_process that injects `windowsHide: true` by default.
 * This prevents spawned processes from creating visible console windows on Windows.
 * On macOS/Linux the option is a no-op.
 *
 * Import from here instead of 'child_process' for all runtime spawns.
 * Callers can override with `{ windowsHide: false }` if a visible window is needed.
 */
import {
  spawn as _spawn,
  execFile as _execFile,
  execFileSync as _execFileSync,
  spawnSync as _spawnSync,
  type SpawnOptions,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  type SpawnSyncOptions,
  type ChildProcess,
  type SpawnSyncReturns,
} from 'child_process';

const DEFAULTS = { windowsHide: true } as const;

export const spawn: typeof _spawn = ((
  command: string,
  argsOrOpts?: readonly string[] | SpawnOptions,
  opts?: SpawnOptions,
): ChildProcess => {
  if (Array.isArray(argsOrOpts)) {
    return _spawn(command, argsOrOpts, { ...DEFAULTS, ...opts });
  }
  return _spawn(command, { ...DEFAULTS, ...(argsOrOpts as SpawnOptions) });
}) as typeof _spawn;

export const execFile: typeof _execFile = ((
  file: string,
  ...rest: any[]
): ChildProcess => {
  // execFile signatures: (file, cb), (file, args, cb), (file, opts, cb), (file, args, opts, cb)
  // Find the options object (if any) and inject defaults
  const args: any[] = rest;
  for (let i = 0; i < args.length; i++) {
    if (args[i] != null && typeof args[i] === 'object' && !Array.isArray(args[i]) && typeof args[i] !== 'function') {
      args[i] = { ...DEFAULTS, ...args[i] };
      return (_execFile as any)(file, ...args);
    }
  }
  // No options object found — insert one before the callback (if any)
  const lastArg = args[args.length - 1];
  if (typeof lastArg === 'function') {
    // (file, cb) or (file, args, cb)
    args.splice(args.length - 1, 0, { ...DEFAULTS });
  } else if (Array.isArray(args[0]) || args.length === 0) {
    // (file) or (file, args) — append options
    args.push({ ...DEFAULTS });
  }
  return (_execFile as any)(file, ...args);
}) as typeof _execFile;

export const execFileSync: typeof _execFileSync = ((
  file: string,
  argsOrOpts?: readonly string[] | ExecFileSyncOptions,
  opts?: ExecFileSyncOptions,
): any => {
  if (Array.isArray(argsOrOpts)) {
    return _execFileSync(file, argsOrOpts, { ...DEFAULTS, ...opts });
  }
  if (argsOrOpts && typeof argsOrOpts === 'object') {
    return _execFileSync(file, { ...DEFAULTS, ...(argsOrOpts as ExecFileSyncOptions) });
  }
  return _execFileSync(file, { ...DEFAULTS });
}) as typeof _execFileSync;

export const spawnSync: typeof _spawnSync = ((
  command: string,
  argsOrOpts?: readonly string[] | SpawnSyncOptions,
  opts?: SpawnSyncOptions,
): SpawnSyncReturns<any> => {
  if (Array.isArray(argsOrOpts)) {
    return _spawnSync(command, argsOrOpts, { ...DEFAULTS, ...opts });
  }
  return _spawnSync(command, { ...DEFAULTS, ...(argsOrOpts as SpawnSyncOptions) });
}) as typeof _spawnSync;

// Re-export types that consumers may need
export type { ChildProcess, SpawnOptions, ExecFileOptions, ExecFileSyncOptions, SpawnSyncOptions, SpawnSyncReturns };
