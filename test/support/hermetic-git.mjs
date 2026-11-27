/**
 * Preloaded into every test process (`node --test --import`, see package.json).
 *
 * Tests build scratch repositories and commit in them. Left alone, git reads the
 * developer's own global config there: a global core.hooksPath runs a scanner on
 * every test commit, a signing key asks for a passphrase, and an identity that
 * the test never set leaks in (#517). So git reads one fixed file instead, with
 * a test identity and no signing, and no system config. A test that sets its
 * own repository config still wins, because local config beats global.
 */
import { fileURLToPath } from 'node:url';

process.env.GIT_CONFIG_GLOBAL = fileURLToPath(new URL('./gitconfig', import.meta.url));
process.env.GIT_CONFIG_NOSYSTEM = '1';
