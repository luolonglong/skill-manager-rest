'use strict';
// ============================================================
//  无头回归：REST 版 Skills 管理端 —— 用例移植自 K:\AI\skill-manager\test-agents.ps1（136 项）
//  差异：全部断言通过 HTTP 调用 server.js 的 REST API（真实客户端-服务端路径），
//        文件系统校验在测试进程内完成；并新增 REST/TUI 冒烟断言。
//  运行：node test\test-agents.js
//        自动生成临时测试配置并拉起测试服务器（独立端口），结束自动清理并恢复环境。
// ============================================================
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 7799;
const BASE = 'http://127.0.0.1:' + PORT;
const TEST_CFG = path.join(ROOT, 'test', '.test-config.json');
const SANDBOX = path.join(ROOT, '.test-sandbox');
const WS_SB = '测试沙箱';
const WS_GLOBAL = '全局（用户级）';

let pass = 0, fail = 0;
const failNames = [];
function Check(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failNames.push(name); console.log('FAIL  ' + name); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function eqCounts(got, exp) {
  if (!got) return false;
  return Object.keys(exp).every(k => got[k] === exp[k]);
}
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
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function getState(ws) {
  const r = await req('GET', '/api/state' + (ws ? '?ws=' + encodeURIComponent(ws) : ''));
  if (r.status !== 200) throw new Error('GET /api/state -> ' + r.status);
  return r.json;
}
async function enable(skills, agent, ws, overwrite) {
  const r = await req('POST', '/api/enable', { skills, agent, ws, overwrite: !!overwrite });
  if (r.status !== 200) throw new Error('enable -> ' + r.status + ' ' + JSON.stringify(r.json));
  return r.json;
}
async function disable(skills, agent, ws) {
  const r = await req('POST', '/api/disable', { skills, agent, ws });
  if (r.status !== 200) throw new Error('disable -> ' + r.status + ' ' + JSON.stringify(r.json));
  return r.json;
}
const rowStatus = (snap, dir, agentName) => {
  const row = snap.rows.find(x => x.dir === dir);
  return row ? row.status[agentName] : '(missing)';
};
function linkState(p) {
  let st; try { st = fs.lstatSync(p); } catch { return 'none'; }
  return st.isSymbolicLink() ? 'linked' : 'copied';
}
function sameReal(a, b) {
  try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); }
  catch { return false; }
}
// 先摘链接再删树（PS5.1 Remove-Item 的教训同样适用于手写遍历，防止跟随 Junction 误删 master）
function rmTreeSafe(p) {
  if (!fs.existsSync(p)) return;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) { try { fs.rmSync(f, { force: true }); } catch { } }
      else if (e.isDirectory()) walk(f);
    }
  };
  walk(p);
  fs.rmSync(p, { recursive: true, force: true });
}

(async () => {
  const server = { proc: null, log: '' };
  try {
    // ---------- 前置 ----------
    rmTreeSafe(SANDBOX);
    const prodCfgPath = path.join(ROOT, 'config.json');
    const prodCfgBefore = fs.readFileSync(prodCfgPath);
    const masterDir = path.join(os.homedir(), '.agents', 'skills');
    const masterBefore = fs.readdirSync(masterDir).filter(n => !n.startsWith('.')).sort();
    Check('前置: master 仓库非空 (' + masterBefore.length + ' 个)', masterBefore.length > 0);
    Check('前置: tdd 在 master 中', fs.existsSync(path.join(masterDir, 'tdd', 'SKILL.md')));
    fs.writeFileSync(TEST_CFG, JSON.stringify({
      masterDir,
      skillRepoMap: {},
      agents: [
        { name: 'ZCode', folder: '.zcode' },
        { name: 'Claude', folder: '.claude' },
        { name: 'Codex', folder: '.codex' },
        { name: 'Grok', folder: '.grok' },
        { name: 'OpenCode', folder: '.opencode' },
      ],
      workspaces: [{ name: WS_GLOBAL, path: '' }, { name: WS_SB, path: SANDBOX }],
      activeWorkspace: WS_GLOBAL,
    }, null, 2));

    // ---------- 拉起测试服务器 ----------
    server.proc = spawn(process.execPath,
      [path.join(ROOT, 'server.js'), '--config', TEST_CFG, '--port', String(PORT)],
      { cwd: ROOT, windowsHide: true });
    server.proc.stdout.on('data', d => { server.log += d; });
    server.proc.stderr.on('data', d => { server.log += d; });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { if ((await req('GET', '/api/health')).status === 200) up = true; } catch { }
      if (!up) await sleep(100);
    }
    Check('REST: 测试服务器启动并响应 /api/health', up);
    if (!up) { console.error(server.log); return; }

    const snap0 = await getState();
    Check('前置: 配置了 5 个 Agent', snap0.agents.length === 5);
    Check('前置: 5 个 Agent 的 folder 唯一', new Set(snap0.agents.map(a => a.folder)).size === 5);

    // ---------- A. 沙箱逐 Agent 启停回路（每 Agent 17 项，与 PS 用例一一对应） ----------
    const agents = snap0.agents;
    const TEST = 'tdd';
    for (const a of agents) {
      const tag = a.name;
      const ad = path.join(SANDBOX, a.folder, 'skills');
      const link = path.join(ad, TEST);

      let c = await enable([TEST], tag, WS_SB);
      Check(`[${tag}] A1 空白启用 -> ok`, eqCounts(c, { ok: 1, skip: 0, conflict: 0, nomaster: 0, fail: 0 }));
      Check(`[${tag}] A2 Junction 已创建`, linkState(link) === 'linked');
      Check(`[${tag}] A3 链接指向 master 原件`, sameReal(link, path.join(masterDir, TEST)));
      Check(`[${tag}] A4 经链接可读取 SKILL.md（Agent 真能用）`, (() => { try { return fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8').length > 0; } catch { return false; } })());
      Check(`[${tag}] A5 扫描状态 = linked（界面显示 ✅）`, rowStatus(await getState(WS_SB), TEST, tag) === 'linked');
      c = await enable([TEST], tag, WS_SB);
      Check(`[${tag}] A6 重复启用 -> skip 幂等`, eqCounts(c, { ok: 0, skip: 1, conflict: 0, nomaster: 0, fail: 0 }));
      c = await disable([TEST], tag, WS_SB);
      Check(`[${tag}] A7 禁用 -> ok`, eqCounts(c, { ok: 1, skip: 0, protected: 0, fail: 0 }));
      Check(`[${tag}] A8 Junction 已移除`, linkState(link) === 'none');
      c = await disable([TEST], tag, WS_SB);
      Check(`[${tag}] A9 空白再禁用 -> skip`, eqCounts(c, { ok: 0, skip: 1, protected: 0, fail: 0 }));
      Check(`[${tag}] A10 master 原件未受影响`, fs.existsSync(path.join(masterDir, TEST, 'SKILL.md')));

      // 边界：链接位置放一个真实目录（模拟 📄 副本）
      fs.mkdirSync(link, { recursive: true });
      fs.writeFileSync(path.join(link, 'marker.txt'), 'real-dir');
      c = await enable([TEST], tag, WS_SB, false);
      Check(`[${tag}] B1 真实目录启用(不覆盖) -> conflict`, eqCounts(c, { ok: 0, skip: 0, conflict: 1, nomaster: 0, fail: 0 }));
      Check(`[${tag}] B2 conflict 后副本内容原样保留`, fs.existsSync(path.join(link, 'marker.txt')) && linkState(link) === 'copied');
      c = await disable([TEST], tag, WS_SB);
      Check(`[${tag}] B3 真实目录禁用 -> protected 不自动删`, eqCounts(c, { ok: 0, skip: 0, protected: 1, fail: 0 }));
      Check(`[${tag}] B4 protected 后副本仍在`, fs.existsSync(path.join(link, 'marker.txt')));
      c = await enable([TEST], tag, WS_SB, true);
      Check(`[${tag}] B5 覆盖启用 -> ok 副本换链接`, eqCounts(c, { ok: 1, skip: 0, conflict: 0, nomaster: 0, fail: 0 }));
      Check(`[${tag}] B6 覆盖后为链接且副本内容已不在`, linkState(link) === 'linked' && !fs.existsSync(path.join(link, 'marker.txt')));
      await disable([TEST], tag, WS_SB);
      c = await enable(['no-such-skill__'], tag, WS_SB);
      Check(`[${tag}] C1 仓库无原件 -> nomaster`, eqCounts(c, { ok: 0, skip: 0, conflict: 0, nomaster: 1, fail: 0 }));
    }

    // ---------- B. 批量路径（agent='*' × 3 个 skill，对应 PS 的 B-1..B-10） ----------
    const batchSkills = ['tdd', 'grilling', 'computer-use'];
    let c = await enable(batchSkills, '*', WS_SB);
    Check('B-1 批量启用 3 skill × 5 agent = 15 全部 ok', eqCounts(c, { ok: 15, skip: 0, conflict: 0, nomaster: 0, fail: 0 }));
    let cnt = 0;
    for (const a of agents) for (const s of batchSkills) {
      if (linkState(path.join(SANDBOX, a.folder, 'skills', s)) === 'linked') cnt++;
    }
    Check('B-2 文件系统 15 个链接全部就位', cnt === 15);
    let snap = await getState(WS_SB);
    Check('B-3 沙箱扫描行数 = master 全量 ' + masterBefore.length, snap.rows.length === masterBefore.length);
    let scanOk = true, otherOk = true;
    for (const row of snap.rows) {
      for (const a of agents) {
        const want = batchSkills.includes(row.dir) ? 'linked' : 'none';
        if (row.status[a.name] !== want) {
          if (want === 'linked') scanOk = false; else otherOk = false;
        }
      }
    }
    Check('B-4 扫描状态: 3 个 skill × 5 agent 全部 linked(✅)', scanOk);
    Check('B-5 扫描状态: 未启用 skill 全部 none(—)', otherOk);
    c = await enable(batchSkills, '*', WS_SB);
    Check('B-6 重复批量启用 15 次全部 skip', eqCounts(c, { ok: 0, skip: 15, conflict: 0, nomaster: 0, fail: 0 }));
    c = await disable(batchSkills, '*', WS_SB);
    Check('B-7 批量禁用 15 个链接全部移除', eqCounts(c, { ok: 15, skip: 0, protected: 0, fail: 0 }));
    let left = 0;
    for (const a of agents) for (const s of batchSkills) {
      if (linkState(path.join(SANDBOX, a.folder, 'skills', s)) !== 'none') left++;
    }
    Check('B-8 禁用后文件系统无残留', left === 0);
    snap = await getState(WS_SB);
    const scanOff = snap.rows.filter(r => batchSkills.includes(r.dir))
      .every(r => agents.every(a => r.status[a.name] === 'none'));
    Check('B-9 禁用后扫描状态全部回到 none(—)', scanOff);
    Check('B-10 批量启停后 master 原件完好',
      fs.existsSync(path.join(masterDir, 'computer-use', 'SKILL.md')) &&
      fs.existsSync(path.join(masterDir, 'grilling', 'SKILL.md')));

    // ---------- C. 真实全局工作空间回路（结束恢复初始状态） ----------
    Check('C-0 切换活动空间 = 全局（用户级）',
      (await req('POST', '/api/workspace', { name: WS_GLOBAL })).status === 200 &&
      (await getState()).activeWorkspace === WS_GLOBAL);
    for (const a of agents) {
      const tag = a.name;
      const ad = path.join(os.homedir(), a.folder, 'skills');
      const link = path.join(ad, TEST);
      const adExisted = fs.existsSync(ad);
      const parentExisted = fs.existsSync(path.dirname(ad));
      const initial = linkState(link);
      if (initial === 'copied') {
        Check(`[${tag}] R-0 tdd 为真实副本 → 只验证保护逻辑，不做启停回路`, true);
        const pc = await enable([TEST], tag);
        Check(`[${tag}] R-0a 真实副本启用(不覆盖) -> conflict`, eqCounts(pc, { ok: 0, skip: 0, conflict: 1, nomaster: 0, fail: 0 }));
        continue;
      }
      const expOk = initial === 'linked' ? 0 : 1, expSkip = initial === 'linked' ? 1 : 0;
      let rc = await enable([TEST], tag);
      Check(`[${tag}] R1 真实启用(初始=${initial}) -> ${initial === 'linked' ? 'skip' : 'ok'}`,
        eqCounts(rc, { ok: expOk, skip: expSkip, conflict: 0, nomaster: 0, fail: 0 }));
      Check(`[${tag}] R2 真实链接有效且 SKILL.md 可读`,
        linkState(link) === 'linked' && sameReal(link, path.join(masterDir, TEST)) && fs.existsSync(path.join(link, 'SKILL.md')));
      rc = await disable([TEST], tag);
      Check(`[${tag}] R3 真实禁用 -> ok`, eqCounts(rc, { ok: 1, skip: 0, protected: 0, fail: 0 }));
      Check(`[${tag}] R4 真实链接已移除`, linkState(link) === 'none');
      if (initial === 'linked') {
        rc = await enable([TEST], tag);
        Check(`[${tag}] R5 恢复原状: 重新启用 -> ok`, eqCounts(rc, { ok: 1, skip: 0, conflict: 0, nomaster: 0, fail: 0 }));
        Check(`[${tag}] R6 恢复后链接有效`, linkState(link) === 'linked' && fs.existsSync(path.join(link, 'SKILL.md')));
      } else {
        Check(`[${tag}] R5 恢复原状: 保持未安装`, linkState(link) === 'none');
        if (!adExisted && fs.existsSync(ad) && fs.readdirSync(ad).length === 0) {
          fs.rmdirSync(ad);
          if (!parentExisted && fs.existsSync(path.dirname(ad)) && fs.readdirSync(path.dirname(ad)).length === 0) {
            fs.rmdirSync(path.dirname(ad));
          }
        }
      }
      Check(`[${tag}] R7 终态 = 初始态(${initial})`, linkState(link) === initial);
    }

    // ---------- REST 专项 ----------
    Check('REST: 未知路由 -> 404', (await req('GET', '/api/nope')).status === 404);
    Check('REST: 未知 Agent -> 400', (await req('POST', '/api/enable', { skills: ['tdd'], agent: 'NoSuch' })).status === 400);
    Check('REST: 未知工作空间 -> 400', (await req('POST', '/api/workspace', { name: '不存在' })).status === 400);
    Check('REST: skills 非数组 -> 400', (await req('POST', '/api/enable', { skills: 'tdd' })).status === 400);
    {
      const u = await req('POST', '/api/update', { skills: ['tabbit'] });
      Check('REST: /api/update 无来源技能(tabbit 手工安装) -> no-source（不联网）',
        u.status === 200 && u.json.results[0].dir === 'tabbit' && u.json.results[0].status === 'no-source');
    }

    // ---------- TUI 冒烟（--once 无头渲染一帧） ----------
    {
      const { execFileSync } = require('child_process');
      const out = execFileSync(process.execPath,
        [path.join(ROOT, 'tui.js'), '--once', '--url', BASE],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      Check('TUI: --once 渲染包含标题与中央仓库', out.includes('Skills 管理端') && out.includes(masterDir));
      Check('TUI: --once 渲染包含 skill 行与状态图标', out.includes('tdd') && out.includes('✅') && out.includes('—'));
    }

    // ---------- 收尾完整性 ----------
    const masterAfter = fs.readdirSync(masterDir).filter(n => !n.startsWith('.')).sort();
    Check('收尾: master 条目前后一致 (' + masterAfter.length + ' 个)',
      masterAfter.length === masterBefore.length && masterAfter.every((n, i) => n === masterBefore[i]));
    Check('收尾: 生产 config.json 未被测试改动', prodCfgBefore.equals(fs.readFileSync(prodCfgPath)));
    rmTreeSafe(SANDBOX);
    Check('收尾: 沙箱已清理', !fs.existsSync(SANDBOX));

  } catch (e) {
    fail++;
    console.log('FAIL  (异常中断) ' + (e && e.stack || e));
  } finally {
    if (server.proc) { try { server.proc.kill(); } catch { } }
    try { rmTreeSafe(SANDBOX); } catch { }
    try { fs.rmSync(TEST_CFG, { force: true }); } catch { }
  }

  console.log('');
  console.log(`RESULT: pass=${pass} fail=${fail}`);
  if (fail > 0) { failNames.forEach(n => console.log('  FAILED: ' + n)); process.exit(1); }
})();
