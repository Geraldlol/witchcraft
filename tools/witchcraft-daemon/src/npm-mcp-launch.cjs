// mcp-setup retains this dependency-free launcher in WITCHCRAFT_HOME. The MCP client starts it
// directly, so its parent is the client even when npm needs to rebuild its execution cache.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

function packageFingerprint(root, files) {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file).update('\0').update(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest());
  }
  return digest.digest('hex');
}
module.exports = { packageFingerprint };

async function launch() {
  const [npmCli, packageSpec] = process.argv.slice(2);
  const runtime = path.join(__dirname, 'mcp-runtime', packageSpec);
  const { sha256, source } = JSON.parse(fs.readFileSync(path.join(runtime, 'current.json'), 'utf8'));
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid retained Witchcraft MCP package');
  process.env.WITCHCRAFT_HOME = __dirname;
  process.env.WITCHCRAFT_MCP_CLIENT_PID = String(process.ppid);
  process.chdir(__dirname);

  // A local/global install already has the needed dependencies and works offline. Reuse it only
  // while it still contains the same package files, including an unpublished same-version build.
  try {
    if (packageFingerprint(source.root, source.files) === source.fingerprint) {
      const entry = path.join(source.root, 'bin', 'witchcraft-mcp.js');
      process.argv = [process.execPath, entry, '--allow-local-writes'];
      await import(pathToFileURL(entry).href);
      return;
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
  }
  // npm resolves file: from cwd. A relative spec keeps profile paths with spaces or percent
  // signs out of npm's file-URL normalization on Windows.
  const archive = `file:./mcp-runtime/${packageSpec}/${sha256}.tgz`;
  process.argv = [process.execPath, npmCli, 'exec', '--yes', '--ignore-scripts', '--package', archive, '--', 'witchcraft-mcp', '--allow-local-writes'];
  require(npmCli);
}

if (require.main === module) launch().catch(error => { console.error(error.message); process.exitCode = 1; });
