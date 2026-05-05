const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const nodeModules = path.join(__dirname, '..', 'node_modules');
let fixed = 0;

try {
  const result = execSync(
    `find "${nodeModules}" -name "spawn-helper" -type f`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  result.trim().split('\n').filter(Boolean).forEach(file => {
    try {
      const stat = fs.statSync(file);
      if (!(stat.mode & 0o111)) {
        fs.chmodSync(file, 0o755);
        console.log(`[fix-node-pty] Fixed: ${file}`);
        fixed++;
      }
    } catch (e) {
      // skip inaccessible files
    }
  });
} catch (e) {
  // find not available (Windows, etc.) — skip gracefully
}

console.log(`[fix-node-pty] Done. Fixed ${fixed} file(s).`);
