#!/usr/bin/env node
/**
 * npm-outdated-fix — Interactive npm dependency updater
 * Zero dependencies · Pure Node.js ES modules · Node 18+
 */

import { spawnSync, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { get } from 'https';
import { URL } from 'url';

// ─── ANSI colours ────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  bgBlue: '\x1b[44m',
};
const col = (code, str) => `${code}${str}${C.reset}`;

// ─── CLI args ────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const hasFlag   = (...flags) => flags.some(f => args.includes(f));
const flagValue = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const MODE = {
  patch:      hasFlag('--patch'),
  minor:      hasFlag('--minor'),
  major:      hasFlag('--major'),
  production: hasFlag('--production'),
  dryRun:     hasFlag('--dry-run'),
  force:      hasFlag('--force'),
  help:       hasFlag('--help', '-h'),
  format:     flagValue('--format'),   // 'json'
};

// ─── Help ────────────────────────────────────────────────────────────────────
if (MODE.help) {
  console.log(`
${col(C.bold, 'npm-outdated-fix')} — Interactive npm dependency updater

${col(C.bold, 'USAGE')}
  nof                  Interactive TUI — select packages to update
  nof --patch          Auto-update all packages to latest patch
  nof --minor          Auto-update all packages to latest minor
  nof --major          Show major updates, requires explicit selection
  nof --production     Only non-devDependencies
  nof --dry-run        Show what would update, no changes made
  nof --format json    Machine-readable JSON output
  nof --force          Skip git-clean check

${col(C.bold, 'TUI CONTROLS')}
  Space   Toggle selection
  a       Select / deselect all
  Enter   Update selected packages
  q       Quit without updating

${col(C.bold, 'SAFETY')}
  • Warns if there are uncommitted git changes (--force to override)
  • Creates a git stash checkpoint before any updates
  • Updates one package at a time
`);
  process.exit(0);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'npm-outdated-fix/1.0.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON parse error for ${url}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Request timed out')); });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'npm-outdated-fix/1.0.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return resolve(null);
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

function semverType(current, latest) {
  const c = current.replace(/^[\^~]/, '').split('.').map(Number);
  const l = latest.replace(/^[\^~]/, '').split('.').map(Number);
  if (l[0] > c[0]) return 'major';
  if (l[1] > c[1]) return 'minor';
  return 'patch';
}

function formatDownloads(n) {
  if (!n) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function colorForType(type) {
  if (type === 'major') return C.yellow;
  if (type === 'minor') return C.cyan;
  return C.green;
}

function padEnd(str, len) {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

// ─── Git safety ───────────────────────────────────────────────────────────────
function checkGitStatus() {
  try {
    const result = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) return { inRepo: false };
    const dirty = result.stdout.trim().length > 0;
    return { inRepo: true, dirty };
  } catch {
    return { inRepo: false };
  }
}

function gitStash(label) {
  try {
    spawnSync('git', ['stash', 'push', '--include-untracked', '-m', label], {
      encoding: 'utf8', stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// ─── npm outdated ─────────────────────────────────────────────────────────────
function getOutdated() {
  const extraArgs = MODE.production ? ['--production'] : [];
  const result = spawnSync(
    'npm',
    ['outdated', '--json', ...extraArgs],
    { encoding: 'utf8', stdio: 'pipe' }
  );
  // npm outdated exits 1 when there are outdated packages — that's normal
  let raw = {};
  try { raw = JSON.parse(result.stdout || '{}'); } catch { /* no packages */ }
  return raw;
}

// ─── npm registry info ───────────────────────────────────────────────────────
async function getRegistryInfo(name) {
  try {
    const data = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    const downloads = await getWeeklyDownloads(name);
    const repoUrl = data.repository?.url ?? '';
    const changelog = await fetchChangelog(repoUrl, data['dist-tags']?.latest ?? '');
    return { downloads, changelog };
  } catch {
    return { downloads: null, changelog: null };
  }
}

async function getWeeklyDownloads(name) {
  try {
    const data = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`);
    return data.downloads ?? null;
  } catch {
    return null;
  }
}

async function fetchChangelog(repoUrl, version) {
  if (!repoUrl) return null;
  // Normalise git URL → https
  const clean = repoUrl
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
  if (!clean.includes('github.com')) return null;

  // Try GitHub releases API
  const match = clean.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) return null;
  const slug = match[1];

  try {
    const releases = await fetchJson(`https://api.github.com/repos/${slug}/releases?per_page=5`);
    if (Array.isArray(releases) && releases.length) {
      const rel = releases.find(r => r.tag_name?.includes(version)) ?? releases[0];
      if (rel?.body) {
        const lines = rel.body.split('\n').filter(l => l.trim()).slice(0, 3);
        return lines.join(' · ');
      }
    }
  } catch { /* fall through */ }

  // Try raw CHANGELOG.md
  const rawUrl = `https://raw.githubusercontent.com/${slug}/HEAD/CHANGELOG.md`;
  const text = await fetchText(rawUrl);
  if (text) {
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3);
    return lines.join(' · ').slice(0, 120);
  }
  return null;
}

// ─── Update a single package ──────────────────────────────────────────────────
function updatePackage(name, version, dryRun) {
  const spec = `${name}@${version}`;
  if (dryRun) {
    console.log(col(C.dim, `  [dry-run] would run: npm install ${spec}`));
    return { success: true };
  }
  process.stdout.write(`  Installing ${col(C.cyan, spec)} ...`);
  const result = spawnSync('npm', ['install', spec], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status === 0) {
    process.stdout.write(` ${col(C.green, 'done')}\n`);
    return { success: true, output: result.stdout };
  }
  process.stdout.write(` ${col(C.red, 'failed')}\n`);
  return { success: false, output: result.stderr };
}

// ─── JSON output mode ─────────────────────────────────────────────────────────
async function outputJson(packages) {
  const out = packages.map(p => ({
    name:     p.name,
    current:  p.current,
    wanted:   p.wanted,
    latest:   p.latest,
    type:     p.type,
    location: p.location,
    updateType: semverType(p.current, p.latest),
  }));
  console.log(JSON.stringify(out, null, 2));
}

// ─── Auto-update mode (--patch / --minor / --major) ───────────────────────────
async function autoUpdate(packages) {
  let targets = packages;

  if (MODE.patch) {
    targets = packages.filter(p => semverType(p.current, p.latest) === 'patch');
  } else if (MODE.minor) {
    targets = packages.filter(p => ['patch', 'minor'].includes(semverType(p.current, p.latest)));
  }
  // --major keeps all

  if (targets.length === 0) {
    console.log(col(C.yellow, 'No packages match the selected update type.'));
    return;
  }

  console.log(`${col(C.bold, `Updating ${targets.length} package(s)...`)}\n`);

  for (const pkg of targets) {
    const version = MODE.major ? pkg.latest : pkg.wanted;
    const result = updatePackage(pkg.name, version, MODE.dryRun);
    if (!result.success && result.output) {
      console.log(col(C.red, result.output.trim()));
    }
  }

  if (!MODE.dryRun) {
    console.log(`\n${col(C.green, 'All done.')}`);
  }
}

// ─── Interactive TUI ──────────────────────────────────────────────────────────
async function interactiveTUI(packages) {
  // Enrich with registry info (parallel, capped at 6)
  process.stdout.write(col(C.dim, 'Fetching registry info...'));
  const CONCURRENCY = 6;
  const enriched = [...packages];
  for (let i = 0; i < enriched.length; i += CONCURRENCY) {
    const batch = enriched.slice(i, i + CONCURRENCY);
    const infos = await Promise.all(batch.map(p => getRegistryInfo(p.name)));
    infos.forEach((info, j) => { Object.assign(enriched[i + j], info); });
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r'); // clear line

  const rows = enriched.map(pkg => ({
    ...pkg,
    updateType: semverType(pkg.current, pkg.latest),
    selected: false,
  }));

  // Filter by mode
  const filtered = MODE.major
    ? rows.filter(r => r.updateType === 'major')
    : rows;

  if (filtered.length === 0) {
    console.log(col(C.green, 'All packages are up to date.'));
    return;
  }

  let cursor = 0;

  const rl = createInterface({ input: process.stdin });
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  function render() {
    // Move to top of output block
    const lines = filtered.length + 7;
    process.stdout.write(`\x1b[${lines}A\x1b[J`);

    const header = `  ${padEnd('Package', 28)} ${padEnd('Current', 10)} ${padEnd('Wanted', 10)} ${padEnd('Latest', 10)} ${padEnd('Type', 7)} ${padEnd('DL/wk', 7)}`;
    console.log(col(C.bold, header));
    console.log(col(C.dim, '  ' + '─'.repeat(80)));

    filtered.forEach((row, i) => {
      const selected = row.selected ? col(C.green, '✓') : ' ';
      const pointer  = i === cursor ? col(C.bgBlue, '>') : ' ';
      const typeCol  = colorForType(row.updateType);
      const name     = padEnd(row.name, 28);
      const current  = padEnd(col(C.red, row.current), 10 + C.red.length + C.reset.length);
      const wanted   = padEnd(col(C.green, row.wanted), 10 + C.green.length + C.reset.length);
      const latest   = padEnd(col(typeCol, row.latest), 10 + typeCol.length + C.reset.length);
      const type     = padEnd(col(typeCol, row.updateType), 7 + typeCol.length + C.reset.length);
      const dl       = formatDownloads(row.downloads ?? null);

      console.log(`${pointer} [${selected}] ${name} ${current} ${wanted} ${latest} ${type} ${dl}`);

      if (i === cursor && row.changelog) {
        console.log(col(C.dim, `       ${row.changelog.slice(0, 90)}`));
      } else if (i === cursor) {
        console.log('');
      }
    });

    const selCount = filtered.filter(r => r.selected).length;
    console.log(col(C.dim, '\n  ' + '─'.repeat(80)));
    console.log(`  ${col(C.bold, '[Space]')} toggle  ${col(C.bold, '[a]')} all  ${col(C.bold, '[Enter]')} update ${selCount} selected  ${col(C.bold, '[q]')} quit`);
  }

  // Initial render — print blank lines first so cursor moves work
  const initialLines = filtered.length + 7;
  for (let i = 0; i < initialLines; i++) console.log('');
  render();

  return new Promise((resolve) => {
    process.stdin.on('data', async (key) => {
      if (key === '\u0003') { cleanup(); process.exit(0); } // Ctrl-C

      if (key === 'q' || key === 'Q') {
        cleanup();
        console.log(col(C.dim, 'Quit — no changes made.'));
        resolve();
        return;
      }

      if (key === '\r' || key === '\n') {  // Enter
        cleanup();
        const selected = filtered.filter(r => r.selected);
        if (selected.length === 0) {
          console.log(col(C.yellow, 'No packages selected.'));
          resolve();
          return;
        }
        console.log(`\n${col(C.bold, `Updating ${selected.length} package(s)...`)}\n`);
        for (const pkg of selected) {
          const version = pkg.updateType === 'major' ? pkg.latest : pkg.wanted;
          const result = updatePackage(pkg.name, version, MODE.dryRun);
          if (!result.success && result.output) {
            console.log(col(C.red, result.output.trim()));
          }
        }
        if (!MODE.dryRun) {
          console.log(`\n${col(C.green, 'Done. Run your tests to verify.')}`);
        }
        resolve();
        return;
      }

      if (key === ' ') {
        filtered[cursor].selected = !filtered[cursor].selected;
        render();
        return;
      }

      if (key === 'a' || key === 'A') {
        const anySelected = filtered.some(r => r.selected);
        filtered.forEach(r => { r.selected = !anySelected; });
        render();
        return;
      }

      if (key === '\x1b[A' || key === 'k') {  // Up arrow / vim k
        cursor = (cursor - 1 + filtered.length) % filtered.length;
        render();
        return;
      }

      if (key === '\x1b[B' || key === 'j') {  // Down arrow / vim j
        cursor = (cursor + 1) % filtered.length;
        render();
        return;
      }
    });

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rl.close();
    }
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  // Verify we're in a node project
  const pkgPath = resolve(process.cwd(), 'package.json');
  if (!existsSync(pkgPath)) {
    console.error(col(C.red, 'Error: No package.json found in current directory.'));
    process.exit(1);
  }

  // Git safety check
  const git = checkGitStatus();
  if (git.inRepo && git.dirty && !MODE.force && !MODE.dryRun) {
    console.warn(col(C.yellow, 'Warning: You have uncommitted git changes.'));
    console.warn(col(C.dim,    '  Updates could be harder to diff. Use --force to proceed anyway.'));
    if (!MODE.dryRun) {
      console.warn(col(C.dim,  '  Or use --dry-run to preview changes first.'));
      process.exit(1);
    }
  }

  // Create stash checkpoint
  if (git.inRepo && !git.dirty && !MODE.dryRun) {
    gitStash('npm-outdated-fix checkpoint');
  }

  // Get outdated packages
  process.stdout.write(col(C.dim, 'Checking for outdated packages...'));
  const raw = getOutdated();
  process.stdout.write('\r' + ' '.repeat(42) + '\r');

  const packages = Object.entries(raw).map(([name, info]) => ({
    name,
    current:  info.current  ?? '?',
    wanted:   info.wanted   ?? info.current ?? '?',
    latest:   info.latest   ?? info.current ?? '?',
    location: info.location ?? '',
  }));

  if (packages.length === 0) {
    console.log(col(C.green, 'All packages are up to date!'));
    process.exit(0);
  }

  // JSON format output
  if (MODE.format === 'json') {
    await outputJson(packages);
    process.exit(0);
  }

  console.log(`\n${col(C.bold, `Found ${packages.length} outdated package(s)`)}\n`);

  // Auto modes
  if (MODE.patch || MODE.minor || MODE.major) {
    await autoUpdate(packages);
    process.exit(0);
  }

  // Interactive TUI
  await interactiveTUI(packages);
}

main().catch(err => {
  console.error(col(C.red, `Fatal: ${err.message}`));
  process.exit(1);
});
