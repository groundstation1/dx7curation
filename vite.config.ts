import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/*
 * Which commit is in the build, stamped in at build time.
 *
 * A published site gives you no way to tell whether what you are looking at is
 * what you last pushed - the assets are content-hashed, so a stale one has a
 * name you would have to already know to recognise. A commit on the About page
 * answers it in one glance, and links to the exact source.
 *
 * A short hash rather than a version number because there is no release
 * process to hang a version on, and because the hash is checkable: it either
 * matches the top of the log or it does not. A tarball with no git history
 * still builds; it just says so.
 */
function describe(): { commit: string; date: string } {
  const git = (args: string) => execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const dirty = git('status --porcelain') !== '';
    return { commit: git('rev-parse --short HEAD') + (dirty ? '+' : ''), date: git('log -1 --format=%cs') };
  } catch {
    return { commit: 'unknown', date: '' };
  }
}

const build = describe();

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: { port: 5173 },
  define: {
    __BUILD_COMMIT__: JSON.stringify(build.commit),
    __BUILD_DATE__: JSON.stringify(build.date),
  },
});
