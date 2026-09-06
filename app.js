'use strict';
// ============================================================
//  Skills 管理端 · 桌面启动器
//  确保 REST 服务在跑（没有就拉起），然后以 App 窗口（无地址栏）
//  打开 Web UI；服务已在跑时只开窗口。启动完即退出。
//  关闭服务：运行 关闭.bat / 关闭.command，或直接结束 node 进程。
// ============================================================
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const URL_ = 'http://127.0.0.1:7741';
const IS_WIN = process.platform === 'win32';

// Node 运行时：打包版用自带的 runtime\node.exe，仓库开发用 PATH 里的 node
function nodeBin() {
  const bundled = path.join(ROOT, 'runtime', IS_WIN ? 'node.exe' : 'node-' + process.platform + '-' + process.arch);
  if (fs.existsSync(bundled)) return bundled;
  return process.execPath;
}
function httpGet(url, timeoutMs) {
  return new Promise(resolve => {
    const req = require('http').get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(timeoutMs || 1500, () => { req.destroy(); resolve(0); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensureServer() {
  if (await httpGet(URL_ + '/api/health')) return { started: false };
  const node = nodeBin();
  const child = spawn(node, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    if (await httpGet(URL_ + '/api/health')) return { started: true, pid: child.pid };
    await sleep(200);
  }
  throw new Error('服务启动超时（端口 7741 被占用或被安全软件拦截）');
}

function openBrowser() {
  const args = ['--app=' + URL_, '--window-size=1180,860'];
  if (IS_WIN) {
    const pf = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LocalAppData'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ].filter(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (candidates.length) {
      spawn(candidates[0], args, { detached: true, stdio: 'ignore' }).unref();
      return candidates[0].includes('msedge') ? 'Edge' : 'Chrome';
    }
    execSync(`start "" "${URL_}"`, { shell: 'cmd.exe' });   // 兜底：默认浏览器
    return '默认浏览器';
  }
  // macOS：优先 Edge / Chrome 的 App 窗口模式，否则默认浏览器
  for (const app of ['Microsoft Edge', 'Google Chrome']) {
    try {
      execSync(`open -na "${app}" --args --app=${URL_} --window-size=1180,860`, { stdio: 'ignore' });
      return app;
    } catch { /* 未安装该浏览器 */ }
  }
  execSync(`open ${URL_}`);
  return '默认浏览器';
}

(async () => {
  try {
    const { started } = await ensureServer();
    if (!process.argv.includes('--no-browser')) {
      const via = openBrowser();
      console.log(`[skills-manager] Web 界面已在 ${via} 中打开: ${URL_}`);
    } else {
      console.log('[skills-manager] 服务就绪: ' + URL_ + '（--no-browser 跳过开窗）');
    }
    if (started) console.log('[skills-manager] 服务已后台启动（关闭请运行 关闭' + (IS_WIN ? '.bat' : '.command') + '）');
    else console.log('[skills-manager] 服务此前已在运行，本次仅打开界面');
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    console.error('[skills-manager] ' + (e.message || e));
    setTimeout(() => process.exit(1), 500);
  }
})();
