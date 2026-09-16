/**
 * Review Voice stores its corpus in Node's built-in SQLite, which is still
 * flagged experimental on Node 22. That warning is addressed to a dependency
 * choice the user never made, so it is filtered out here. Every other warning
 * is printed exactly as Node would print it.
 */
export function suppressSqliteExperimentalWarning(): void {
  const handlers = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) {
      return;
    }
    if (handlers.length > 0) {
      for (const handler of handlers) handler(warning);
      return;
    }
    process.emitWarning(warning.message, warning.name);
  });
}
