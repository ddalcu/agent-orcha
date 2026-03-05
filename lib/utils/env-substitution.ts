/**
 * Replaces ${ENV_VAR} and ${ENV_VAR:-default} placeholders in a string
 * with values from process.env. Unresolved vars are left as-is.
 */
export function substituteEnvVars(content: string): string {
  return content.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g,
    (_match, name: string, defaultValue: string | undefined) => {
      const value = process.env[name];
      if (value !== undefined) return value;
      if (defaultValue !== undefined) return defaultValue;
      return _match;
    },
  );
}
