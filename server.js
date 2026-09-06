'use strict';
// ============================================================
//  Skills 管理端 · REST 服务（零依赖：仅 Node 内置模块）
//  只绑定 127.0.0.1，不对外网暴露；所有状态修改走 POST。
//
//  用法：node server.js [--config <config.json>] [--port 7741] [--host 127.0.0.1]
// ============================================================
const http = require('http');
const path = require('path');
const lib = require('./lib');

const argv = process.argv.slice(2);
function argOf(k, d) { const i = argv.indexOf(k); return (i >= 0 && argv[i + 1]) ? argv[i + 1] : d; }
const CONFIG_PATH = path.resolve(argOf('--config', path.join(__dirname, 'config.json')));
const PORT = parseInt(argOf('--port', '7741'), 10);
const HOST = argOf('--host', '127.0.0.1');

const cfg = lib.loadConfig(CONFIG_PATH);
const lock = lib.readLock(cfg.masterDir);

function save() { lib.saveConfig(CONFIG_PATH, cfg); }
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function findWs(name) {
  if (!name) return lib.activeWorkspace(cfg);
  return cfg.workspaces.find(w => w.name === name) || null;
}
function snapshot(wsName) {
  const ws = findWs(wsName);
  if (!ws) return null;
  return {
    masterDir: cfg.masterDir,
    masterCount: lib.listDirs(cfg.masterDir).length,
    platform: process.platform,
    agents: cfg.agents,
    workspaces: cfg.workspaces,
    activeWorkspace: lib.activeWorkspace(cfg).name,
    workspace: { name: ws.name, root: lib.workspaceRoot(ws) },
    rows: lib.scan(cfg, lock, ws),
  };
}

const server = http.createServer(async (req, res) => {
  let p;
  try { p = new URL(req.url, 'http://localhost').pathname; } catch { return send(res, 400, { error: 'bad url' }); }
  try {
    if (req.method === 'GET') {
      if (p === '/api/health') return send(res, 200, { ok: true, version: '1.0.0', platform: process.platform });
      if (p === '/api/state') {
        const wsName = new URL(req.url, 'http://localhost').searchParams.get('ws');
        const snap = snapshot(wsName || undefined);
        if (!snap) return send(res, 400, { error: '未知工作空间: ' + wsName });
        return send(res, 200, snap);
      }
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          '<meta charset="utf-8"><title>Skills 管理端 REST</title><pre>' +
          'Skills 管理端 REST 服务\n\n' +
          'GET  /api/health                 健康检查\n' +
          'GET  /api/state?ws=空间名        全量快照（rows 含每个 Agent 的 linked/copied/none）\n' +
          'POST /api/workspace {name}       切换活动工作空间\n' +
          'POST /api/workspaces {add:{name,path}}  添加项目工作空间\n' +
          'POST /api/enable   {skills:[], agent:"*"|名字, ws?, overwrite?}\n' +
          'POST /api/disable  {skills:[], agent:"*"|名字, ws?}\n' +
          'POST /api/repo     {dir, repo}   手动标注仓库分组（repo 留空清除）\n\n' +
          '终端界面：node tui.js  （需本服务已启动）</pre>'
        );
      }
      return send(res, 404, { error: 'not found: ' + p });
    }

    if (req.method === 'POST') {
      const body = await readBody(req).catch(e => { throw Object.assign(new Error(e.message), { statusCode: 400 }); });

      if (p === '/api/workspace') {
        const ws = cfg.workspaces.find(w => w.name === body.name);
        if (!ws) return send(res, 400, { error: '未知工作空间: ' + body.name });
        cfg.activeWorkspace = ws.name;
        save();
        return send(res, 200, { ok: true, activeWorkspace: ws.name });
      }

      if (p === '/api/workspaces') {
        const add = body.add || {};
        if (!add.path) return send(res, 400, { error: '缺少 add.path' });
        if (cfg.workspaces.some(w => w.path === add.path)) return send(res, 200, { ok: true, duplicate: true });
        const name = add.name || path.basename(add.path);
        cfg.workspaces = cfg.workspaces.concat([{ name, path: add.path }]);
        save();
        return send(res, 200, { ok: true, name });
      }

      if (p === '/api/enable' || p === '/api/disable') {
        const isEnable = p === '/api/enable';
        const skills = Array.isArray(body.skills) ? body.skills.map(String) : null;
        if (!skills || skills.length === 0) return send(res, 400, { error: 'skills 必须是非空数组' });
        const agent = body.agent || '*';
        const targets = agent === '*' ? cfg.agents : cfg.agents.filter(a => a.name === agent);
        if (targets.length === 0) return send(res, 400, { error: '未知 Agent: ' + agent });
        const ws = findWs(body.ws);
        if (!ws) return send(res, 400, { error: '未知工作空间: ' + body.ws });
        const counts = isEnable
          ? { ok: 0, skip: 0, conflict: 0, nomaster: 0, fail: 0 }
          : { ok: 0, skip: 0, protected: 0, fail: 0 };
        for (const s of skills) {
          for (const a of targets) {
            const ad = lib.agentDir(cfg, ws, a.folder);
            const r = isEnable
              ? lib.enableSkill(cfg, s, ad, !!body.overwrite)
              : lib.disableSkill(s, ad);
            counts[r] = (counts[r] || 0) + 1;
          }
        }
        return send(res, 200, counts);
      }

      if (p === '/api/repo') {
        const dir = body.dir ? String(body.dir) : '';
        if (!dir) return send(res, 400, { error: '缺少 dir' });
        const repo = String(body.repo || '').trim();
        if (!repo || repo === '（未分组）') delete cfg.skillRepoMap[dir];
        else cfg.skillRepoMap[dir] = repo;
        save();
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'not found: ' + p });
    }

    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, e.statusCode || 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[skills-manager] REST: http://${HOST}:${PORT}   config: ${CONFIG_PATH}`);
  console.log(`[skills-manager] master: ${cfg.masterDir}   platform: ${process.platform}`);
});
