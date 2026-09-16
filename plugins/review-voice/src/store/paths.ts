import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Review Voice stores everything outside the repository under review, in the
 * platform's own data directory. Keeping it out of the repo means a corpus can
 * never be committed by accident, and honouring XDG/AppData means it lands
 * where a user's backup and privacy tooling already looks.
 */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['REVIEW_VOICE_DATA_DIR'];
  if (override !== undefined && override.length > 0) return override;

  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'review-voice');
    case 'win32': {
      const appData = env['APPDATA'];
      return appData !== undefined && appData.length > 0
        ? join(appData, 'review-voice')
        : join(home, 'AppData', 'Roaming', 'review-voice');
    }
    default: {
      const xdg = env['XDG_DATA_HOME'];
      return xdg !== undefined && xdg.length > 0
        ? join(xdg, 'review-voice')
        : join(home, '.local', 'share', 'review-voice');
    }
  }
}

export function databasePath(env?: NodeJS.ProcessEnv): string {
  return join(dataDirectory(env), 'review-voice.db');
}
