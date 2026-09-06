'use strict';
// ============================================================
//  Skills 管理端 · 核心逻辑（跨平台：Windows Junction / macOS Symlink）
//  与 PowerShell 版 SkillManager.ps1 的非界面部分语义对齐：
//    启用   = 在 <空间根>\<.工具名>\skills\<skill> 创建指向中央仓库原件的链接
//    禁用   = 只移除链接，绝不删除真实目录
//  返回码与 PS 版一致：
//    enable : ok / skip / conflict / nomaster / fail
//    disable: ok / skip / protected / fail
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

// ---------------- 配置 ----------------
function defaultConfig() {
  return {
    masterDir: path.join(os.homedir(), '.agents', 'skills'),
    skillRepoMap: {},
    agents: [
      { name: 'ZCode',    folder: '.zcode'    },
      { name: 'Claude',   folder: '.claude'   },
      { name: 'Codex',    folder: '.codex'    },
      { name: 'Grok',     folder: '.grok'     },
      { name: 'OpenCode', folder: '.opencode' },
    ],
    workspaces: [{ name: '全局（用户级）', path: '' }],
    activeWorkspace: '全局（用户级）',
  };
}

function loadConfig(configPath) {
  const cfg = defaultConfig();
  if (fs.existsSync(configPath)) {
    let raw = fs.readFileSync(configPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // 兼容 PS 生成的 BOM
    const parsed = JSON.parse(raw);
    Object.assign(cfg, parsed);
  }
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) cfg.agents = defaultConfig().agents;
  for (const a of cfg.agents) {
    if (!a.folder) {   // 兼容旧 {name, skillsDir}
      const m = /\\([^\\]+)\\skills\\?$/.exec(String(a.skillsDir || ''));
      a.folder = m ? m[1] : '.agents';
    }
  }
  if (!Array.isArray(cfg.workspaces) || cfg.workspaces.length === 0) cfg.workspaces = defaultConfig().workspaces;
  if (!cfg.skillRepoMap || typeof cfg.skillRepoMap !== 'object') cfg.skillRepoMap = {};
  if (!cfg.activeWorkspace) cfg.activeWorkspace = cfg.workspaces[0].name;
  return cfg;
}

function saveConfig(configPath, cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------------- 工作空间 / 目录解析 ----------------
function workspaceRoot(ws) {
  if (!ws || !ws.path) return os.homedir();
  return ws.path;
}
function activeWorkspace(cfg) {
  const ws = cfg.workspaces.find(w => w.name === cfg.activeWorkspace);
  return ws || cfg.workspaces[0];
}
function agentDir(cfg, ws, folder) {
  return path.join(workspaceRoot(ws), folder, 'skills');
}

// ---------------- 来源溯源（npx skills 的 .skill-lock.json）----------------
function readLock(masterDir) {
  const lockMap = {}, lockUrl = {};
  const cands = [
    path.join(path.dirname(masterDir), '.skill-lock.json'),
    path.join(masterDir, '.skill-lock.json'),
  ];
  for (const cand of cands) {
    try {
      if (!fs.existsSync(cand)) continue;
      const lock = JSON.parse(fs.readFileSync(cand, 'utf8'));
      for (const [name, info] of Object.entries(lock.skills || {})) {
        if (!lockMap[name]) {
          lockMap[name] = String(info.source || '');
          lockUrl[name] = String(info.sourceUrl || '');
        }
      }
      break;   // 与 PS 版一致：只读第一个存在的候选
    } catch { /* 损坏的 lock 文件当作不存在 */ }
  }
  return { map: lockMap, url: lockUrl };
}

// ---------------- Skill 元数据（SKILL.md frontmatter）----------------
function skillMeta(dir) {
  let name = path.basename(dir);
  let desc = '';
  try {
    const lines = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').split(/\r?\n/).slice(0, 30);
    for (let i = 0; i < lines.length; i++) {
      let m = /^name:\s*(.+)$/.exec(lines[i]);
      if (m) name = m[1].trim();
      m = /^description:\s*(.+)$/.exec(lines[i]);
      if (m) {
        let d = m[1].trim();
        if (/^[>|]/.test(d)) {                       // 多行 description（> 或 | 开头）
          const parts = [];
          let j = i + 1;
          while (j < lines.length && /^\s{2,}(.+)$/.test(lines[j])) { parts.push(/^\s{2,}(.+)$/.exec(lines[j])[1].trim()); j++; }
          d = parts.join(' ');
        }
        desc = d;
      }
    }
  } catch { /* 无 SKILL.md：用目录名 */ }
  if (desc.length > 60) desc = desc.slice(0, 60) + '…';
  return { name, description: desc };
}

// ---------------- 链接状态（Junction / SymbolicLink 统一按 symlink 识别）----------------
function linkState(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 'none'; }
  return st.isSymbolicLink() ? 'linked' : 'copied';
}
function linkTarget(p) {
  try { return fs.readlinkSync(p); } catch { return ''; }
}
function sameReal(a, b) {
  try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); }
  catch { return false; }
}
function createLink(target, linkPath) {
  try { fs.symlinkSync(target, linkPath, IS_WIN ? 'junction' : 'dir'); return true; }
  catch { return false; }
}
function removeLink(p) {
  // symlink/junction 本体删除，不跟随到目标（POSIX 需 unlink，Windows 两者兼容处理）
  try { fs.rmSync(p, { force: true, recursive: false }); }
  catch { try { fs.rmdirSync(p); } catch { /* 落到最后的存在性校验 */ } }
  return linkState(p) === 'none';
}

// 仓库分组优先级：手动标注 > .skill-lock.json > 链接目标反推 > （本项目）/（未分组）
function repoFromLink(linkPath) {
  let cur;
  try { cur = fs.realpathSync(linkPath); } catch { return ''; }
  while (cur && cur.length > 3) {
    if (path.basename(cur) === 'skills') {
      const repoDir = path.dirname(cur);
      if (fs.existsSync(path.join(repoDir, '.git'))) return path.basename(repoDir);
    }
    cur = path.dirname(cur);
  }
  return '';
}
function repoLabel(cfg, lock, dirName, dirPath, inMaster) {
  if (cfg.skillRepoMap[dirName]) return String(cfg.skillRepoMap[dirName]);
  if (lock.map[dirName]) return lock.map[dirName];
  if (linkState(dirPath) === 'linked') {
    const r = repoFromLink(dirPath);
    if (r) return r;
  }
  return inMaster ? '（未分组）' : '（本项目）';
}

// ---------------- 扫描 ----------------
// 注：相对 PowerShell 版的改进 —— 忽略以 . 开头的目录（如 Codex 内部的 .system），
//     避免内部目录被当作可启停的 skill 行。
function listDirs(dir) {
  try {
    // 目录或链接都算（与 PS Get-ChildItem -Directory 一致；macOS 上链接的 Dirent 不是 isDirectory）
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map(d => d.name);
  } catch { return []; }
}
function scan(cfg, lock, ws) {
  const rows = [];
  const seen = new Set();
  const masterDirs = listDirs(cfg.masterDir);

  // 本工作空间内各 Agent 目录里已有、但仓库没有的 skill（项目私有 skill）
  const wsOnly = {};
  const probeFolders = [...new Set(cfg.agents.map(a => a.folder).concat('.agents'))];
  for (const f of probeFolders) {
    const ad = agentDir(cfg, ws, f);
    for (const name of listDirs(ad)) {
      if (!seen.has(name) && !fs.existsSync(path.join(cfg.masterDir, name))) {
        seen.add(name);
        wsOnly[name] = path.join(ad, name);
      }
    }
  }

  for (const name of masterDirs) {
    seen.add(name);
    rows.push(makeRow(cfg, lock, name, path.join(cfg.masterDir, name), true, ws));
  }
  for (const name of Object.keys(wsOnly).sort()) {
    rows.push(makeRow(cfg, lock, name, wsOnly[name], false, ws));
  }
  rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.skill.localeCompare(b.skill));
  return rows;
}
function makeRow(cfg, lock, dirName, dirPath, inMaster, ws) {
  const meta = skillMeta(dirPath);
  const status = {};
  for (const a of cfg.agents) {
    status[a.name] = linkState(path.join(agentDir(cfg, ws, a.folder), dirName));
  }
  return {
    dir: dirName,
    skill: meta.name,
    desc: meta.description,
    repo: repoLabel(cfg, lock, dirName, dirPath, inMaster),
    url: (lock.url[dirName] || '').replace(/\.git$/, ''),
    inMaster,
    status,
  };
}

// ---------------- 启用 / 禁用 ----------------
function enableSkill(cfg, skillDirName, agentDirPath, overwrite) {
  const src = path.join(cfg.masterDir, skillDirName);
  if (!fs.existsSync(src)) return 'nomaster';                 // 仓库里没有原件，无法链接
  fs.mkdirSync(agentDirPath, { recursive: true });
  const link = path.join(agentDirPath, skillDirName);
  const st = linkState(link);
  if (st === 'linked') {
    const tgt = linkTarget(link);
    if (tgt && sameReal(link, src)) return 'skip';            // 已指向原件，幂等
    if (!removeLink(link)) return 'fail';                     // 旧链接指向别处：替换
  } else if (st === 'copied') {
    if (!overwrite) return 'conflict';                        // 真实副本：默认绝不删除
    try { fs.rmSync(link, { recursive: true, force: true }); } catch { return 'fail'; }
  }
  if (!createLink(src, link)) return 'fail';
  return linkState(link) === 'linked' && sameReal(link, src) ? 'ok' : 'fail';
}

function disableSkill(skillDirName, agentDirPath) {
  const link = path.join(agentDirPath, skillDirName);
  const st = linkState(link);
  if (st === 'none') return 'skip';
  if (st !== 'linked') return 'protected';                    // 真实目录绝不自动删
  return removeLink(link) ? 'ok' : 'fail';
}

// ---------------- 远程更新（GitHub 来源技能 → 拉上游最新替换 master 原件）----------------
function ghToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
function ghJSON(apiPath, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com', path: apiPath, method: 'GET',
      headers: {
        'user-agent': 'skills-manager',
        'accept': 'application/vnd.github+json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
    }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error('GitHub API HTTP ' + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('GitHub API 请求超时')));
    req.end();
  });
}
function ghDownload(url, dest, token) {
  return new Promise((resolve, reject) => {
    const get = (u, n) => {
      const uo = new URL(u);
      const req = https.request({
        host: uo.host, path: uo.pathname + uo.search, method: 'GET',
        headers: {
          'user-agent': 'skills-manager',
          ...(token && uo.host === 'api.github.com' ? { authorization: 'Bearer ' + token } : {}),
        },
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 4) {
          res.resume();
          return get(res.headers.location, n + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 HTTP ' + res.statusCode)); }
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve(dest)));
        f.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
      req.end();
    };
    get(url, 0);
  });
}

// 在仓库树中定位 dirName 技能所在目录（上游可能用任意层级/改名）：
// 1) 路径名为 <dirName>/SKILL.md 或以 /<dirName>/SKILL.md 结尾（最浅优先，含仓库根 SKILL.md）
// 2) frontmatter name == dirName 兜底
async function locateSkillInRepo(base, dirName, branch, token) {
  const tree = await ghJSON(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
  if (tree.truncated) throw new Error('仓库文件树过大，无法枚举（truncated）');
  const paths = (tree.tree || [])
    .filter(t => t.type === 'blob' && (t.path === 'SKILL.md' || t.path.endsWith('/SKILL.md')))
    .map(t => t.path);
  const byName = paths
    .filter(p => p === dirName + '/SKILL.md' || p.endsWith('/' + dirName + '/SKILL.md'))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  if (byName[0]) return byName[0].slice(0, -'/SKILL.md'.length);
  for (const p of paths.slice(0, 12)) {
    try {
      const enc = p.split('/').map(encodeURIComponent).join('/');
      const raw = await ghJSON(`${base}/contents/${enc}?ref=${encodeURIComponent(branch)}`, token);
      const content = Buffer.from(raw.content || '', 'base64').toString('utf8');
      const nm = /^name:\s*(.+)$/m.exec(content);
      if (nm && nm[1].trim() === dirName) return p.slice(0, -'/SKILL.md'.length);
    } catch { /* 单个候选失败继续 */ }
  }
  throw new Error(`仓库中未找到技能 ${dirName}（共 ${paths.length} 个 SKILL.md，路径名与 frontmatter 均不匹配）`);
}

// 把 owner/repo 中 dirName 技能的最新版替换到 master；返回 {status: updated|unsupported|error, detail}
async function updateFromGithub(cfg, dirName, repoUrl) {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/.exec(repoUrl);
  if (!m) return { status: 'unsupported', detail: '仅支持 github.com 来源（' + repoUrl + '）' };
  const owner = m[1], repo = m[2];
  const token = ghToken();
  const base = `/repos/${owner}/${repo}`;
  let branch;
  try { branch = (await ghJSON(base, token)).default_branch || 'main'; }
  catch (e) { return { status: 'error', detail: '读取仓库信息失败: ' + e.message }; }

  let skillDir;
  try { skillDir = await locateSkillInRepo(base, dirName, branch, token); }
  catch (e) { return { status: 'error', detail: e.message }; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-upd-'));
  try {
    const tgz = 'repo.tgz';
    await ghDownload(`https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(branch)}`, path.join(tmp, tgz), token);
    // tar 注意事项：-f 用相对路径（cwd=tmp），GNU tar 会把 "C:\..." 解析成 远程主机:文件；
    // Windows 优先用系统自带 bsdtar（Git 自带的 GNU tar 在无特权时建 symlink 会失败）
    let tarBin = 'tar';
    if (process.platform === 'win32') {
      const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      if (fs.existsSync(bsdtar)) tarBin = bsdtar;
    }
    const listing = execFileSync(tarBin, ['-tzf', tgz], { cwd: tmp, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const top = listing.split(/\r?\n/)[0].replace(/\/+$/, '');
    if (!top) return { status: 'error', detail: '下载的压缩包为空' };
    // 只解出所需子树，避免仓库里无关 symlink/大文件拖累
    const members = skillDir ? [top + '/' + skillDir] : [top];
    execFileSync(tarBin, ['-xzf', tgz, ...members], { cwd: tmp, maxBuffer: 16 * 1024 * 1024 });
    const src = path.join(tmp, top, skillDir);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { status: 'error', detail: '下载内容缺少 SKILL.md，放弃替换' };

    // 备份 → 替换 → 失败回滚（Junction 按路径解析，同路径重建后仍有效）
    const dest = path.join(cfg.masterDir, dirName);
    const bak = path.join(tmp, 'old');
    const hadOld = fs.existsSync(dest);
    if (hadOld) fs.cpSync(dest, bak, { recursive: true });
    try {
      if (hadOld) fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    } catch (e) {
      if (hadOld) {
        try { fs.rmSync(dest, { recursive: true, force: true }); fs.cpSync(bak, dest, { recursive: true }); } catch { }
      }
      throw e;
    }
    return { status: 'updated', detail: `${dirName} ← ${owner}/${repo}@${branch}${skillDir ? '/' + skillDir : ''}` };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
}

module.exports = {
  IS_WIN,
  defaultConfig, loadConfig, saveConfig,
  workspaceRoot, activeWorkspace, agentDir,
  readLock, skillMeta, listDirs,
  linkState, linkTarget, sameReal, createLink, removeLink,
  repoLabel, scan,
  enableSkill, disableSkill,
  updateFromGithub,
};
