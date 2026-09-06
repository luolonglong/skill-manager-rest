'use strict';
// ============================================================
//  Skills 管理端 · TUI 终端前端（零依赖：ANSI 渲染，走 REST）
//  用法：node tui.js [--url http://127.0.0.1:7741] [--once] [--no-server]
//    --once       渲染一帧后退出（无头冒烟测试用）
//    --no-server  不自动拉起 server.js
//  按键：↑/↓ 移动 · 空格 勾选 · a 全选 · i 反选 · ←/→ 目标 Agent
//        w 切工作空间 · e 启用 · d 禁用 · o 覆盖副本 · r 刷新 · q 退出
// ============================================================
const http = require('http');
const readline = require('readline');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
function argOf(k, d) { const i = args.indexOf(k); return (i >= 0 && args[i + 1]) ? args[i + 1] : d; }
const BASE = argOf('--url', 'http://127.0.0.1:7741').replace(/\/+$/, '');
const ONCE = args.includes('--once');
const AUTO_SERVER = !args.includes('--no-server') && !ONCE;
const ANSI = process.stdout.isTTY || args.includes('--force-ansi');

// ---------------- REST 客户端（零依赖，node:http）----------------
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(BASE + p, {
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error('请求超时')));
    if (data) r.write(data);
    r.end();
  });
}

// ---------------- 界面状态 ----------------
const GLYPH = { linked: '✅', copied: '📄', none: '—' };
const S = {
  state: null,
  selected: new Set(),     // key = row.dir
  cursor: 0,               // S.flat 里的行号（只计 skill 行）
  agentIdx: 0,             // 0 = 全部 Agent
  overwrite: false,
  msg: '就绪',
  flat: [],                // [{header}|{row}]
  child: null,             // 自动拉起的 server.js
};

async function refresh(msg) {
  try {
    const r = await req('GET', '/api/state');
    if (r.status !== 200 || !r.json || !r.json.rows) { S.msg = '获取状态失败: HTTP ' + r.status; return false; }
    S.state = r.json;
    const valid = new Set(S.state.rows.map(x => x.dir));
    for (const k of [...S.selected]) if (!valid.has(k)) S.selected.delete(k);
    if (S.state.agents && S.agentIdx > S.state.agents.length) S.agentIdx = 0;
    if (msg) S.msg = msg;
    return true;
  } catch (e) {
    S.msg = '连接失败: ' + e.message;
    return false;
  }
}

function targetName() {
  if (!S.state) return '*';
  return S.agentIdx === 0 ? '*' : S.state.agents[S.agentIdx - 1].name;
}

// ---------------- 渲染 ----------------
function pad(s, n) {
  s = String(s || '');
  let w = 0, out = '';
  for (const ch of s) { w += ch.charCodeAt(0) > 0xFF ? 2 : 1; if (w > n) return out + '…'; out += ch; }
  return out + ' '.repeat(n - w);
}
function render() {
  const st = S.state;
  if (!st) return;
  const width = process.stdout.columns || 120;
  const nameW = 22, repoW = 20, descW = Math.max(20, Math.min(46, width - 22 - 20 - 8 - st.agents.length * 4 - 10));
  const L = [];

  // 表头
  L.push('\x1b[1m  Skills 管理端 (TUI)\x1b[0m   平台: ' + st.platform +
    '   中央仓库: ' + st.masterDir + ' (' + st.masterCount + ' 个)');
  L.push('  空间: \x1b[36m' + st.workspace.name + '\x1b[0m (w 切换)   根: ' + st.workspace.root);
  L.push('  目标: \x1b[36m' + (S.agentIdx === 0 ? '全部 Agent' : st.agents[S.agentIdx - 1].name) + '\x1b[0m (←/→)' +
    '   覆盖副本: ' + (S.overwrite ? '\x1b[31m开\x1b[0m' : '关') + ' (o)' +
    '   已勾选 ' + S.selected.size + ' / ' + st.rows.length);
  L.push('  ' + '─'.repeat(Math.max(10, width - 4)));

  // 行（按仓库分组；与扫描排序一致，遇到新 repo 输出组头）
  S.flat = [];
  let lastRepo = null;
  for (const row of st.rows) {
    if (row.repo !== lastRepo) {
      lastRepo = row.repo;
      const n = st.rows.filter(x => x.repo === row.repo).length;
      S.flat.push({ header: true, text: ' \x1b[1;34m◆ ' + row.repo + '\x1b[0m \x1b[90m(' + n + ' 个)\x1b[0m' });
    }
    S.flat.push({ row });
  }
  // 找到第 cursor 个 skill 行的显示位置
  let seen = -1, cursorPos = 0;
  for (let i = 0; i < S.flat.length; i++) {
    if (!S.flat[i].header) { seen++; if (seen === S.cursor) { cursorPos = i; break; } }
  }
  for (let i = 0; i < S.flat.length; i++) {
    const it = S.flat[i];
    if (it.header) { L.push(it.text); continue; }
    const row = it.row;
    const checked = S.selected.has(row.dir);
    const cur = i === cursorPos;
    const cells = [
      (checked ? '[x]' : '[ ]'),
      pad(row.skill, nameW),
      pad(row.repo, repoW),
      pad(row.desc, descW),
      ...st.agents.map(a => pad(GLYPH[row.status[a.name]] || '—', 3)),
    ].join(' ');
    L.push((cur ? '\x1b[7m' : '') + ' ' + cells + (cur ? '\x1b[0m' : ''));
  }

  // 底部
  L.push('  ' + '─'.repeat(Math.max(10, width - 4)));
  L.push('  \x1b[90m↑↓ 移动 · 空格 勾选 · a 全选 · i 反选 · ←/→ 目标 · w 空间 · e 启用 · d 禁用 · o 覆盖 · r 刷新 · q 退出\x1b[0m');
  L.push('  ' + S.msg);
  process.stdout.write(L.join('\r\n') + '\r\n');
}

// ---------------- 操作 ----------------
function move(d) {
  const n = S.flat.filter(x => !x.header).length;
  if (n === 0) return;
  S.cursor = (S.cursor + d + n) % n;
}
function currentRow() {
  let seen = -1;
  for (const it of S.flat) {
    if (!it.header) { seen++; if (seen === S.cursor) return it.row; }
  }
  return null;
}
function countsMsg(kind, c) {
  if (kind === 'enable') {
    let m = `启用完成: 成功 ${c.ok}, 跳过(已存在) ${c.skip}, 副本冲突 ${c.conflict}, 仓库无原件 ${c.nomaster}, 失败 ${c.fail}`;
    if (c.conflict > 0) m += ' （真实副本默认保护，可按 o 开覆盖后再启用）';
    return m;
  }
  let m = `禁用完成: 移除链接 ${c.ok}, 跳过 ${c.skip}, 保留真实目录 ${c.protected}, 失败 ${c.fail}`;
  if (c.protected > 0) m += ' （真实目录不会被自动删除）';
  return m;
}
async function batch(kind) {
  const skills = [...S.selected];
  if (skills.length === 0) { S.msg = '请先勾选要' + (kind === 'enable' ? '启用' : '禁用') + '的 Skills（空格勾选 / a 全选）'; return; }
  try {
    const r = await req('POST', '/api/' + kind, { skills, agent: targetName(), overwrite: S.overwrite });
    if (r.status !== 200) { S.msg = '失败: HTTP ' + r.status + ' ' + (r.json && r.json.error || ''); return; }
    S.msg = countsMsg(kind, r.json);
    await refresh();
  } catch (e) { S.msg = '请求失败: ' + e.message; }
}
async function switchWorkspace() {
  const list = S.state.workspaces;
  const idx = list.findIndex(w => w.name === S.state.activeWorkspace);
  const next = list[(idx + 1) % list.length];
  const r = await req('POST', '/api/workspace', { name: next.name });
  if (r.status !== 200) { S.msg = '切换失败: ' + (r.json && r.json.error || r.status); return; }
  await refresh('已切换到空间【' + next.name + '】');
}

// ---------------- 键盘 ----------------
function onKey(ch, key) {
  if (!key) return;
  if (key.ctrl && key.name === 'c') return quitApp();
  switch (key.name) {
    case 'q': return quitApp();
    case 'up': move(-1); break;
    case 'down': move(1); break;
    case 'space': {
      const row = currentRow();
      if (row) { S.selected.has(row.dir) ? S.selected.delete(row.dir) : S.selected.add(row.dir); }
      break;
    }
    case 'a': for (const it of S.flat) if (it.row) S.selected.add(it.row.dir); break;
    case 'i': for (const it of S.flat) { if (!it.row) continue; S.selected.has(it.row.dir) ? S.selected.delete(it.row.dir) : S.selected.add(it.row.dir); } break;
    case 'left': S.agentIdx = (S.agentIdx - 1 + S.state.agents.length + 1) % (S.state.agents.length + 1); break;
    case 'right': case 't': S.agentIdx = (S.agentIdx + 1) % (S.state.agents.length + 1); break;
    case 'w': switchWorkspace().then(render).catch(e => { S.msg = e.message; render(); }); return;
    case 'e': batch('enable').then(render); return;
    case 'd': batch('disable').then(render); return;
    case 'o': S.overwrite = !S.overwrite; S.msg = '覆盖已有副本: ' + (S.overwrite ? '开（启用会把副本替换为链接，不可恢复）' : '关'); break;
    case 'r': refresh('已刷新').then(render); return;
    default: return;
  }
  render();
}

function quitApp() {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { }
  if (S.child) { try { S.child.kill(); } catch { } }
  process.stdout.write('\x1b[?25h');   // 恢复光标
  process.exit(0);
}

// ---------------- 启动 ----------------
async function waitHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200) return true; } catch { }
    await new Promise(res => setTimeout(res, 150));
  }
  return false;
}

(async function main() {
  if (AUTO_SERVER) {
    let up = await waitHealth(600);
    if (!up) {
      S.child = spawn(process.execPath,
        [path.join(__dirname, 'server.js'), '--port', String(new URL(BASE).port || 7741)],
        { stdio: 'ignore', windowsHide: true });
      up = await waitHealth(4000);
      if (!up) { console.error('无法启动/连接 REST 服务: ' + BASE + '（也可手动运行 node server.js）'); process.exit(1); }
    }
  }

  if (!(await refresh())) {
    console.error('无法连接 REST 服务: ' + BASE + ' — 请先运行: node server.js');
    process.exit(1);
  }

  if (ONCE) {
    render();
    process.stdout.write('', () => process.exit(0));
    return;
  }

  if (!process.stdout.isTTY) {
    console.error('TUI 需要在真实终端中运行（TTY）。无头调用请用: node tui.js --once');
    process.exit(1);
  }

  process.stdout.write('\x1b[?25l');   // 隐藏光标
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', onKey);
  process.stdin.on('data', buf => { if (buf.includes(0x03)) quitApp(); });
  process.on('SIGINT', quitApp);
  process.stdout.on('resize', render);
  render();
})();
