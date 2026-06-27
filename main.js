const { app, BrowserWindow, ipcMain, shell, safeStorage, nativeImage, Tray, Menu, dialog } = require('electron');
const net = require('net');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const url = require('url');
const os = require('os');
const { execFile, spawn } = require('child_process');
const Store = require('electron-store');
const { machineIdSync } = require('node-machine-id');
const { Launch } = require('minecraft-java-core');

// ---------------------------------------------------------------------------
// File logger
// ---------------------------------------------------------------------------
var LOG_DIR = path.join(
  process.env.APPDATA || process.env.HOME || os.homedir(),
  'skyzeradventure-launcher', 'logs'
);
var LOG_FILE = path.join(LOG_DIR, 'launcher.log');
var logStream = null;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
    var oldLog = LOG_FILE + '.old';
    try { fs.unlinkSync(oldLog); } catch (e) {}
    fs.renameSync(LOG_FILE, oldLog);
  }
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch (e) {}

function logToFile(level, args) {
  if (!logStream) return;
  try {
    var ts = new Date().toISOString();
    var msg = '[' + ts + '] [' + level + '] ' + Array.prototype.slice.call(args).map(function (a) {
      if (a instanceof Error) return a.message + '\n' + (a.stack || '');
      if (typeof a === 'object') try { return JSON.stringify(a); } catch (e) { return String(a); }
      return String(a);
    }).join(' ');
    logStream.write(msg + '\n');
  } catch (e) {}
}

var origLog = console.log;
var origWarn = console.warn;
var origError = console.error;
console.log = function () { origLog.apply(console, arguments); logToFile('INFO', arguments); };
console.warn = function () { origWarn.apply(console, arguments); logToFile('WARN', arguments); };
console.error = function () { origError.apply(console, arguments); logToFile('ERROR', arguments); };

console.log('=== Skyzer: Adventures Beyond Launcher started ===');
console.log('Version: ' + require('./package.json').version);
console.log('Platform: ' + process.platform + ' ' + process.arch);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SITE_URL = 'https://eriniumgroup.vercel.app';
const MANIFEST_URL = SITE_URL + '/api/skyzer/manifest';
const APP_VERSION = require('./package.json').version;
const MC_VERSION = '1.20.1';
const GAME_DIR = path.join(app.getPath('appData'), '.skyzeradventure');
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_RETRIES = 3;
const FILE_TIMEOUT = 60000;

// Xbox Live public client_id — used by many open-source MC launchers (Prism, MultiMC etc.)
const MSA_CLIENT_ID = '000000004C12AE6F';
const MSA_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';

let store;
try {
  store = new Store({
    name: 'skyzer-launcher',
    encryptionKey: crypto.createHash('sha256').update('skyzer-' + (machineIdSync(true) || 'default')).digest('hex'),
  });
} catch (e) {
  const storePath = path.join(app.getPath('userData'), 'skyzer-launcher.json');
  try { fs.unlinkSync(storePath); } catch (_) {}
  store = new Store({
    name: 'skyzer-launcher',
    encryptionKey: crypto.createHash('sha256').update('skyzer-' + (machineIdSync(true) || 'default')).digest('hex'),
  });
}

let mainWindow = null;
let splashWindow = null;
let loginWindow = null;
let msaWindow = null;
let currentUser = null;
let gameProcess = null;
let tray = null;
let isQuitting = false;
const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const IS_PRODUCTION = app.isPackaged;

// ---------------------------------------------------------------------------
// HWID
// ---------------------------------------------------------------------------
function collectHWID() {
  try { return machineIdSync(true); } catch (e) {
    return crypto.createHash('sha256').update(os.platform() + os.arch() + os.totalmem()).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// User management (stores MC access token, no JWT)
// ---------------------------------------------------------------------------
function saveUser(user) {
  try {
    const json = JSON.stringify(user);
    if (safeStorage.isEncryptionAvailable()) {
      store.set('user', safeStorage.encryptString(json).toString('base64'));
    } else {
      store.set('user', json);
    }
    currentUser = user;
  } catch (e) {
    console.error('[Skyzer] saveUser error:', e.message);
  }
}

function getUser() {
  if (currentUser) return currentUser;
  const val = store.get('user');
  if (!val) return null;
  try {
    let str;
    if (safeStorage.isEncryptionAvailable()) {
      str = safeStorage.decryptString(Buffer.from(val, 'base64'));
    } else {
      str = val;
    }
    currentUser = JSON.parse(str);
    return currentUser;
  } catch (e) {
    return null;
  }
}

function clearUser() {
  store.delete('user');
  currentUser = null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function fetchJSON(urlStr, headers) {
  return new Promise((resolve) => {
    function doFetch(reqUrl, redirectCount) {
      if (redirectCount > 5) return resolve(null);
      var mod = reqUrl.startsWith('https') ? https : http;
      var options = { timeout: 20000 };
      if (headers && typeof headers === 'object') options.headers = headers;
      var req = mod.get(reqUrl, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var loc = res.headers.location;
          if (!loc.startsWith('http')) loc = new url.URL(loc, reqUrl).toString();
          return doFetch(loc, redirectCount + 1);
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    }
    doFetch(urlStr, 0);
  });
}

function postJSON(urlStr, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new url.URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json',
      }, extraHeaders || {}),
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Réponse JSON invalide de ' + urlStr)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Requête expirée vers ' + urlStr)); });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 600,
    frame: false,
    transparent: true,
    resizable: false,
    icon: iconPath,
    alwaysOnTop: true,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !IS_PRODUCTION,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'src', 'splash', 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 400,
    height: 600,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    icon: iconPath,
    backgroundColor: '#04040f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !IS_PRODUCTION,
    },
  });
  loginWindow.loadFile(path.join(__dirname, 'src', 'login', 'login.html'));
  loginWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.close(); splashWindow = null; }
    loginWindow.show();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    minWidth: 1000,
    minHeight: 600,
    frame: false,
    center: true,
    icon: iconPath,
    show: false,
    backgroundColor: '#04040f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !IS_PRODUCTION,
      webviewTag: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'main', 'main.html'));
  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.close(); splashWindow = null; }
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.close(); loginWindow = null; }
    mainWindow.show();
  });
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

// ---------------------------------------------------------------------------
// Microsoft / Xbox / Minecraft auth chain
// ---------------------------------------------------------------------------
async function performMinecraftAuth(msToken) {
  console.log('[Skyzer] Auth: Xbox Live...');
  const xblRes = await postJSON('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: msToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  }, { 'x-xbl-contract-version': '0' });

  if (!xblRes || !xblRes.Token) throw new Error('Authentification Xbox Live échouée');

  console.log('[Skyzer] Auth: XSTS...');
  const xstsRes = await postJSON('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblRes.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });

  if (!xstsRes || !xstsRes.Token) {
    if (xstsRes && xstsRes.XErr === 2148916233) {
      throw new Error('Aucun compte Xbox Live lié. Rendez-vous sur xbox.com pour en créer un.');
    }
    if (xstsRes && xstsRes.XErr === 2148916238) {
      throw new Error('Compte mineur non autorisé sans supervision parentale.');
    }
    throw new Error('Authentification XSTS échouée (code ' + (xstsRes && xstsRes.XErr) + ')');
  }

  const userHash = xstsRes.DisplayClaims.xui[0].uhs;

  console.log('[Skyzer] Auth: Minecraft...');
  const mcRes = await postJSON('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: 'XBL3.0 x=' + userHash + ';' + xstsRes.Token,
  });
  if (!mcRes || !mcRes.access_token) throw new Error('Authentification Minecraft échouée');

  console.log('[Skyzer] Auth: Profil Minecraft...');
  const profileRes = await fetchJSON('https://api.minecraftservices.com/minecraft/profile', {
    'Authorization': 'Bearer ' + mcRes.access_token,
  });

  if (!profileRes || !profileRes.id) {
    throw new Error('Profil Minecraft introuvable. Vérifiez que Minecraft Java Edition est acheté sur ce compte.');
  }

  const rawId = profileRes.id;
  const uuid = rawId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

  return {
    name: profileRes.name,
    uuid: uuid,
    accessToken: mcRes.access_token,
    expiresAt: Date.now() + (mcRes.expires_in || 86400) * 1000,
  };
}

function startMsaAuth() {
  return new Promise((resolve, reject) => {
    if (msaWindow && !msaWindow.isDestroyed()) {
      msaWindow.focus();
      return reject(new Error('Une fenêtre de connexion est déjà ouverte'));
    }

    const authUrl = 'https://login.live.com/oauth20_authorize.srf?' + new URLSearchParams({
      client_id: MSA_CLIENT_ID,
      response_type: 'token',
      redirect_uri: MSA_REDIRECT,
      scope: 'service::user.auth.xboxlive.com::MBI_SSL',
      display: 'touch',
      locale: 'fr',
    }).toString();

    msaWindow = new BrowserWindow({
      width: 500,
      height: 680,
      frame: true,
      resizable: true,
      center: true,
      show: false,
      title: 'Connexion Microsoft',
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    msaWindow.loadURL(authUrl);
    msaWindow.once('ready-to-show', () => msaWindow.show());

    let resolved = false;

    function handleCallback(navUrl) {
      if (!navUrl.startsWith(MSA_REDIRECT)) return false;
      const fragment = navUrl.split('#')[1] || '';
      const params = new URLSearchParams(fragment);
      const msToken = params.get('access_token');

      if (!msToken) {
        if (!resolved) { resolved = true; reject(new Error('Pas de token dans la réponse Microsoft')); }
        return true;
      }

      resolved = true;
      if (msaWindow && !msaWindow.isDestroyed()) { msaWindow.close(); msaWindow = null; }

      performMinecraftAuth(msToken).then(resolve).catch(reject);
      return true;
    }

    msaWindow.webContents.on('will-navigate', (event, navUrl) => {
      if (handleCallback(navUrl)) event.preventDefault();
    });

    msaWindow.webContents.on('will-redirect', (event, navUrl) => {
      if (handleCallback(navUrl)) event.preventDefault();
    });

    msaWindow.webContents.on('did-navigate', (_event, navUrl) => {
      handleCallback(navUrl);
    });

    msaWindow.on('closed', () => {
      msaWindow = null;
      if (!resolved) { resolved = true; reject(new Error('Connexion annulée')); }
    });
  });
}

// ---------------------------------------------------------------------------
// Java detection & download (Java 17+)
// ---------------------------------------------------------------------------
function getJavaVersion(javaPath) {
  return new Promise(function (resolve) {
    execFile(javaPath, ['-version'], function (err, stdout, stderr) {
      if (err) return resolve(null);
      var output = (stderr || '') + (stdout || '');
      var match = output.match(/(?:java|openjdk)\s+version\s+"([^"]+)"/i);
      if (!match) match = output.match(/(\d+[\d._]+)/);
      if (match) return resolve(match[1]);
      resolve(null);
    });
  });
}

function getMajorVersion(versionStr) {
  if (!versionStr) return 0;
  var parts = versionStr.split(/[._-]/);
  var major = parseInt(parts[0], 10);
  if (major === 1 && parts.length > 1) return parseInt(parts[1], 10);
  return major;
}

function getJavaBinaryName() { return process.platform === 'win32' ? 'javaw.exe' : 'java'; }
function getJavaBinaryFallback() { return process.platform === 'win32' ? 'java.exe' : 'java'; }

function findJavaExecutables() {
  var candidates = [];
  var env = process.env;
  var isWin = process.platform === 'win32';
  var isMac = process.platform === 'darwin';
  var binName = getJavaBinaryName();
  var binFallback = getJavaBinaryFallback();

  if (env.JAVA_HOME) {
    candidates.push(path.join(env.JAVA_HOME, 'bin', binName));
    if (binName !== binFallback) candidates.push(path.join(env.JAVA_HOME, 'bin', binFallback));
  }

  var ownJavaDir = path.join(app.getPath('appData'), '.skyzeradventure', 'java');
  var searchDirs = [ownJavaDir];

  if (isWin) {
    var programFiles = env['ProgramFiles'] || 'C:\\Program Files';
    var programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    var localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    searchDirs.push(
      path.join(programFiles, 'Java'),
      path.join(programFiles, 'Eclipse Adoptium'),
      path.join(programFiles, 'Amazon Corretto'),
      path.join(programFiles, 'Zulu'),
      path.join(programFiles, 'Microsoft'),
      path.join(programFilesX86, 'Java'),
      path.join(localAppData, 'Programs')
    );
  } else if (isMac) {
    searchDirs.push(
      '/Library/Java/JavaVirtualMachines',
      path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines'),
      '/usr/local/opt/openjdk@17',
      '/opt/homebrew/opt/openjdk@17'
    );
  } else {
    searchDirs.push('/usr/lib/jvm', '/usr/java', '/opt/java',
      path.join(os.homedir(), '.sdkman', 'candidates', 'java'));
  }

  searchDirs.forEach(function (dir) {
    try {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach(function (entry) {
        var binDir = path.join(dir, entry, 'bin');
        var macBin = path.join(dir, entry, 'Contents', 'Home', 'bin');
        [binDir, macBin].forEach(function (d) {
          var javaBin = path.join(d, binName);
          var javaFallback = path.join(d, binFallback);
          if (fs.existsSync(javaBin)) candidates.push(javaBin);
          else if (fs.existsSync(javaFallback)) candidates.push(javaFallback);
        });
      });
    } catch (e) {}
  });

  try {
    var cmd = isWin ? 'where javaw.exe 2>nul' : 'which java 2>/dev/null';
    var result = require('child_process').execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    result.split('\n').forEach(function (line) {
      var p = line.trim();
      if (p && fs.existsSync(p)) candidates.push(p);
    });
  } catch (e) {}

  var seen = {};
  return candidates.filter(function (c) {
    var norm = isWin ? path.resolve(c).toLowerCase() : path.resolve(c);
    if (seen[norm]) return false;
    seen[norm] = true;
    return fs.existsSync(c);
  });
}

async function autoDetectJava() {
  var candidates = findJavaExecutables();
  var results = [];
  for (var i = 0; i < candidates.length; i++) {
    var version = await getJavaVersion(candidates[i]);
    if (version) results.push({ path: candidates[i], version: version, major: getMajorVersion(version) });
  }
  // Prefer Java 17+
  results.sort(function (a, b) {
    var aOk = a.major >= 17 ? 1 : 0;
    var bOk = b.major >= 17 ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;
    return b.major - a.major;
  });
  if (results.length > 0) return { found: true, path: results[0].path, version: results[0].version };
  return { found: false, path: '', version: '' };
}

function downloadFile(downloadUrl, destPath, progressCallback) {
  return new Promise(function (resolve, reject) {
    function doRequest(reqUrl, redirectCount) {
      if (redirectCount > 10) return reject(new Error('Trop de redirections'));
      var currentMod = reqUrl.startsWith('https') ? https : http;
      currentMod.get(reqUrl, { timeout: 30000 }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var newUrl = res.headers.location;
          if (!newUrl.startsWith('http')) newUrl = new url.URL(newUrl, reqUrl).toString();
          return doRequest(newUrl, redirectCount + 1);
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        var totalSize = parseInt(res.headers['content-length'], 10) || 0;
        var downloaded = 0;
        var file = fs.createWriteStream(destPath);
        res.on('data', function (chunk) {
          downloaded += chunk.length;
          file.write(chunk);
          if (progressCallback && totalSize > 0) progressCallback({ downloaded, total: totalSize, percent: Math.round(downloaded / totalSize * 100) });
        });
        res.on('end', function () { file.end(function () { resolve(destPath); }); });
        res.on('error', function (err) { file.close(); try { fs.unlinkSync(destPath); } catch (e) {} reject(err); });
      }).on('error', reject).on('timeout', function () { reject(new Error('Timeout')); });
    }
    doRequest(downloadUrl, 0);
  });
}

async function extractArchive(archivePath, destDir) {
  return new Promise(function (resolve, reject) {
    var cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-Command', 'Expand-Archive -Path "' + archivePath.replace(/\\/g, '\\\\') + '" -DestinationPath "' + destDir.replace(/\\/g, '\\\\') + '" -Force'];
    } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      cmd = 'tar'; args = ['xzf', archivePath, '-C', destDir];
    } else {
      cmd = 'unzip'; args = ['-o', archivePath, '-d', destDir];
    }
    execFile(cmd, args, { timeout: 120000 }, function (err, _stdout, stderr) {
      if (err) return reject(new Error('Extraction échouée: ' + (stderr || err.message)));
      resolve();
    });
  });
}

async function downloadAndInstallJava(senderWebContents) {
  var javaBaseDir = path.join(app.getPath('appData'), '.skyzeradventure', 'java');
  try { fs.mkdirSync(javaBaseDir, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }

  var adoptiumOs, adoptiumArch, archiveExt;
  switch (process.platform) {
    case 'win32':  adoptiumOs = 'windows'; break;
    case 'darwin': adoptiumOs = 'mac'; break;
    default:       adoptiumOs = 'linux'; break;
  }
  switch (process.arch) {
    case 'arm64': adoptiumArch = 'aarch64'; break;
    case 'arm':   adoptiumArch = 'arm'; break;
    default:      adoptiumArch = 'x64'; break;
  }
  archiveExt = process.platform === 'win32' ? '.zip' : '.tar.gz';

  var archivePath = path.join(javaBaseDir, 'jdk-download' + archiveExt);
  var downloadUrl = 'https://api.adoptium.net/v3/binary/latest/17/ga/' + adoptiumOs + '/' + adoptiumArch + '/jdk/hotspot/normal/eclipse?project=jdk';

  function sendProgress(data) {
    if (senderWebContents && !senderWebContents.isDestroyed()) senderWebContents.send('java:download-progress', data);
  }

  sendProgress({ status: 'downloading', percent: 0, message: 'Téléchargement de Java 17...' });

  try {
    await downloadFile(downloadUrl, archivePath, function (p) {
      sendProgress({ status: 'downloading', percent: p.percent, downloaded: p.downloaded, total: p.total, message: 'Téléchargement... ' + p.percent + '%' });
    });
  } catch (err) {
    sendProgress({ status: 'error', message: 'Échec du téléchargement: ' + err.message });
    throw err;
  }

  sendProgress({ status: 'extracting', percent: 100, message: 'Extraction en cours...' });
  try { await extractArchive(archivePath, javaBaseDir); } catch (err) {
    sendProgress({ status: 'error', message: 'Extraction échouée: ' + err.message });
    throw err;
  }
  try { fs.unlinkSync(archivePath); } catch (e) {}

  var binName = getJavaBinaryName();
  var entries = fs.readdirSync(javaBaseDir);
  var javaBinPath = null;
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].startsWith('jdk-')) continue;
    var base = path.join(javaBaseDir, entries[i]);
    var direct = path.join(base, 'bin', binName);
    if (fs.existsSync(direct)) { javaBinPath = direct; break; }
    var macPath = path.join(base, 'Contents', 'Home', 'bin', binName);
    if (fs.existsSync(macPath)) { javaBinPath = macPath; break; }
    var fallback = path.join(base, 'bin', getJavaBinaryFallback());
    if (fs.existsSync(fallback)) { javaBinPath = fallback; break; }
  }

  if (!javaBinPath) { sendProgress({ status: 'error', message: 'Java introuvable après extraction' }); throw new Error('Java introuvable après extraction'); }

  var version = await getJavaVersion(javaBinPath);
  sendProgress({ status: 'done', percent: 100, message: 'Java 17 installé avec succès !', path: javaBinPath, version: version || '17' });
  return { path: javaBinPath, version: version || '17' };
}

async function resolveJavaPath(settings) {
  if (settings && settings.javaPath) {
    var userVer = await getJavaVersion(settings.javaPath);
    if (getMajorVersion(userVer) >= 17) return settings.javaPath;
    console.log('[Skyzer] Configured Java v' + getMajorVersion(userVer) + ' < 17, ignoring');
  }
  var detected = await autoDetectJava();
  if (detected.found && getMajorVersion(detected.version) >= 17) return detected.path;
  return null;
}

// ---------------------------------------------------------------------------
// File management — manifest-based SHA-256 verification
// ---------------------------------------------------------------------------
function hashFile(filePath) {
  return new Promise(function (resolve, reject) {
    var hash = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath);
    stream.on('data', function (chunk) { hash.update(chunk); });
    stream.on('end', function () { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}

function ensureDir(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

async function fetchRemoteManifest() {
  for (var _i = 0; _i < 2; _i++) {
    console.log('[Skyzer] Manifeste: tentative ' + (_i + 1) + '...');
    var _r = await fetchJSON(MANIFEST_URL);
    if (_r && Array.isArray(_r.files)) {
      console.log('[Skyzer] Manifeste reçu: ' + _r.files.length + ' fichiers');
      return _r;
    }
    console.warn('[Skyzer] Manifeste: tentative ' + (_i + 1) + ' échouée (null ou invalide)');
  }
  return null;
}

function loadLocalManifest() {
  var manifestPath = path.join(GAME_DIR, '.skyzer-manifest.json');
  try { if (fs.existsSync(manifestPath)) return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch (e) {}
  return null;
}

function saveLocalManifest(manifest) {
  ensureDir(GAME_DIR);
  fs.writeFileSync(path.join(GAME_DIR, '.skyzer-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

async function compareManifests(remote, local) {
  var toDownload = [], toDelete = [];
  if (!remote || !remote.files) return { toDownload, toDelete };
  var localMap = {};
  if (local && local.files) local.files.forEach(function (f) { localMap[f.path] = f; });

  console.log('[Skyzer] Comparaison de ' + remote.files.length + ' fichiers...');
  for (var j = 0; j < remote.files.length; j++) {
    var remoteFile = remote.files[j];
    var fullPath = path.join(GAME_DIR, remoteFile.path);
    if (!fs.existsSync(fullPath)) {
      toDownload.push(remoteFile);
    } else {
      var localHash = await hashFile(fullPath);
      if (localHash !== remoteFile.sha256) toDownload.push(remoteFile);
    }
    delete localMap[remoteFile.path];
  }

  Object.keys(localMap).forEach(function (key) {
    if (localMap[key].category === 'mod') toDelete.push(localMap[key]);
  });

  return { toDownload, toDelete };
}

function downloadGameFile(fileUrl, destPath, expectedHash, progressCallback) {
  return new Promise(function (resolve, reject) {
    var tmpPath = destPath + '.tmp';
    ensureDir(path.dirname(destPath));
    var attempt = 0;

    function tryDownload() {
      attempt++;
      function doRequest(reqUrl, redirectCount) {
        if (redirectCount > 10) return reject(new Error('Trop de redirections'));
        var currentMod = reqUrl.startsWith('https') ? https : http;
        currentMod.get(reqUrl, { timeout: FILE_TIMEOUT }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            var loc = res.headers.location;
            if (!loc.startsWith('http')) loc = new url.URL(loc, reqUrl).toString();
            return doRequest(loc, redirectCount + 1);
          }
          if (res.statusCode !== 200) {
            if (attempt < MAX_RETRIES) { setTimeout(tryDownload, Math.pow(2, attempt) * 1000); return; }
            return reject(new Error('HTTP ' + res.statusCode + ' pour ' + fileUrl));
          }
          var totalSize = parseInt(res.headers['content-length'], 10) || 0;
          var downloaded = 0;
          var file = fs.createWriteStream(tmpPath);
          res.on('data', function (chunk) {
            downloaded += chunk.length;
            file.write(chunk);
            if (progressCallback && totalSize > 0) progressCallback({ downloaded, total: totalSize, percent: Math.round(downloaded / totalSize * 100) });
          });
          res.on('end', function () {
            file.end(function () {
              if (expectedHash) {
                hashFile(tmpPath).then(function (actualHash) {
                  if (actualHash !== expectedHash) {
                    try { fs.unlinkSync(tmpPath); } catch (e) {}
                    if (attempt < MAX_RETRIES) setTimeout(tryDownload, Math.pow(2, attempt) * 1000);
                    else reject(new Error('Hash mismatch pour ' + destPath));
                  } else {
                    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); fs.renameSync(tmpPath, destPath); } catch (e) { return reject(e); }
                    resolve(destPath);
                  }
                }).catch(function (err) { try { fs.unlinkSync(tmpPath); } catch (e) {} reject(err); });
              } else {
                try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); fs.renameSync(tmpPath, destPath); } catch (e) { return reject(e); }
                resolve(destPath);
              }
            });
          });
          res.on('error', function (err) {
            file.close(); try { fs.unlinkSync(tmpPath); } catch (e) {}
            if (attempt < MAX_RETRIES) setTimeout(tryDownload, Math.pow(2, attempt) * 1000);
            else reject(err);
          });
        }).on('error', function (err) {
          if (attempt < MAX_RETRIES) setTimeout(tryDownload, Math.pow(2, attempt) * 1000);
          else reject(err);
        }).on('timeout', function () {
          if (attempt < MAX_RETRIES) setTimeout(tryDownload, Math.pow(2, attempt) * 1000);
          else reject(new Error('Timeout pour ' + fileUrl));
        });
      }
      doRequest(fileUrl, 0);
    }
    tryDownload();
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' Mo';
  return (bytes / 1073741824).toFixed(1) + ' Go';
}

async function downloadManifestFiles(files, webContents) {
  if (!files || files.length === 0) return;
  var totalBytes = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
  var downloadedBytes = 0, completedFiles = 0, totalFiles = files.length;
  var startTime = Date.now(), lastProgressTime = 0;
  var queue = files.slice(), errors = [];

  while (queue.length > 0) {
    var batch = queue.splice(0, MAX_CONCURRENT_DOWNLOADS);
    var promises = [];
    for (var j = 0; j < batch.length; j++) {
      (function (file) {
        var destPath = path.join(GAME_DIR, file.path);
        var fileDownloaded = 0;
        var promise = downloadGameFile(file.url, destPath, file.sha256, function (progress) {
          var delta = progress.downloaded - fileDownloaded;
          fileDownloaded = progress.downloaded;
          downloadedBytes += delta;
          var now = Date.now();
          if (now - lastProgressTime >= 200) {
            lastProgressTime = now;
            var elapsed = (now - startTime) / 1000;
            var speed = elapsed > 0 ? downloadedBytes / elapsed : 0;
            var remaining = speed > 0 ? (totalBytes - downloadedBytes) / speed : 0;
            var globalPercent = totalBytes > 0 ? Math.round(downloadedBytes / totalBytes * 100) : 0;
            var detail = completedFiles + '/' + totalFiles + ' fichiers (' + globalPercent + '%)';
            if (speed > 0) detail += ' — ' + formatBytes(speed) + '/s';
            if (remaining > 0 && remaining < 99999) detail += ' — ~' + Math.ceil(remaining) + 's restantes';
            sendProgress(webContents, 'Téléchargement...', globalPercent, detail);
          }
        }).then(function () { completedFiles++; }).catch(function (err) {
          errors.push({ file: file.path, error: err.message });
          console.error('[Skyzer] Échec téléchargement ' + file.path + ':', err.message);
        });
        promises.push(promise);
      })(batch[j]);
    }
    await Promise.all(promises);
  }

  var requiredErrors = errors.filter(function (e) {
    var matchingFile = files.find(function (f) { return f.path === e.file; });
    return matchingFile && matchingFile.required;
  });
  if (requiredErrors.length > 0) {
    throw new Error('Échec de ' + requiredErrors.length + ' fichier(s) requis: ' + requiredErrors.map(function (e) { return e.file; }).join(', '));
  }
}

function deleteRemovedFiles(filesToDelete) {
  filesToDelete.forEach(function (f) {
    var fullPath = path.join(GAME_DIR, f.path);
    try { if (fs.existsSync(fullPath)) { fs.unlinkSync(fullPath); console.log('[Skyzer] Supprimé (retiré du manifeste): ' + f.path); } } catch (e) {}
  });
}

function enforceModsWhitelist(manifest) {
  var modsDir = path.join(GAME_DIR, 'mods');
  if (!fs.existsSync(modsDir)) return [];
  var allowedFiles = {};
  if (manifest && manifest.files) {
    manifest.files.filter(function (f) { return f.category === 'mod'; }).forEach(function (f) { allowedFiles[path.basename(f.path)] = true; });
  }
  if (manifest && manifest.allowedMods) {
    manifest.allowedMods.forEach(function (m) { allowedFiles[path.basename(m.path)] = true; });
  }
  var moved = [];
  try {
    fs.readdirSync(modsDir).forEach(function (entry) {
      if (!entry.endsWith('.jar')) return;
      if (allowedFiles[entry]) return;
      var src = path.join(modsDir, entry);
      try { fs.unlinkSync(src); moved.push(entry); console.log('[Skyzer] Mod non autorisé supprimé: ' + entry); } catch (e) {}
    });
  } catch (e) {}
  return moved;
}

async function syncOptionalMods(manifest, settings) {
  if (!manifest || !manifest.allowedMods || manifest.allowedMods.length === 0) return;
  var enabledMods = (settings && settings.optionalMods) ? settings.optionalMods : {};
  var modsDir = path.join(GAME_DIR, 'mods');
  ensureDir(modsDir);
  for (var i = 0; i < manifest.allowedMods.length; i++) {
    var mod = manifest.allowedMods[i];
    var fileName = path.basename(mod.path);
    var localPath = path.join(modsDir, fileName);
    var isEnabled = enabledMods[fileName] === true;
    if (isEnabled) {
      if (!fs.existsSync(localPath) && mod.url) {
        try { await downloadFile(mod.url, localPath); } catch (err) { console.warn('[Skyzer] Mod optionnel échec: ' + fileName, err.message); }
      }
    } else {
      if (fs.existsSync(localPath)) try { fs.unlinkSync(localPath); } catch (e) {}
    }
  }
}

function cleanupTmpFiles() {
  ['mods', 'config', 'resourcepacks'].forEach(function (d) {
    var dir = path.join(GAME_DIR, d);
    try {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach(function (f) { if (f.endsWith('.tmp')) try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
    } catch (e) {}
  });
}

// ---------------------------------------------------------------------------
// Progress / Status helpers
// ---------------------------------------------------------------------------
function sendProgress(webContents, step, percent, detail) {
  if (webContents && !webContents.isDestroyed()) webContents.send('game:progress', { step, percent, detail: detail || '' });
}

function sendStatus(webContents, status, message) {
  if (webContents && !webContents.isDestroyed()) webContents.send('game:status', { status, message: message || '' });
}

// ---------------------------------------------------------------------------
// Download manifest files, then launch with minecraft-java-core (Forge 1.20.1)
// ---------------------------------------------------------------------------
async function checkAndDownloadGame(webContents) {
  cleanupTmpFiles();
  ensureDir(GAME_DIR);

  sendStatus(webContents, 'checking', 'Récupération du manifeste...');
  var remoteManifest = await fetchRemoteManifest();
  var localManifest = loadLocalManifest();
  var effectiveManifest = remoteManifest || localManifest;

  if (effectiveManifest) {
    var comparison = await compareManifests(effectiveManifest, localManifest);

    if (comparison.toDelete.length > 0) deleteRemovedFiles(comparison.toDelete);

    if (comparison.toDownload.length > 0) {
      sendStatus(webContents, 'downloading', 'Téléchargement des fichiers du modpack...');
      sendProgress(webContents, 'Téléchargement...', 0, comparison.toDownload.length + ' fichier(s)');
      await downloadManifestFiles(comparison.toDownload, webContents);
    } else {
      console.log('[Skyzer] Tous les fichiers sont à jour');
    }

    if (remoteManifest) saveLocalManifest(remoteManifest);

    sendProgress(webContents, 'Vérification des mods...', 95, '');
    var movedMods = enforceModsWhitelist(effectiveManifest);
    if (movedMods.length > 0) console.log('[Skyzer] ' + movedMods.length + ' mod(s) non autorisé(s) supprimés');

    var settings = store.get('settings', getDefaultSettings());
    await syncOptionalMods(effectiveManifest, settings);
  } else {
    console.warn('[Skyzer] Aucun manifeste disponible, lancement hors ligne');
  }

  sendProgress(webContents, 'Prêt !', 100, '');
  return { manifest: effectiveManifest };
}

function getDefaultSettings() {
  return {
    ram: 4,
    javaPath: '',
    gameDir: GAME_DIR,
    jvmArgs: '',
    closeOnLaunch: false,
    notifications: true,
    language: 'fr',
  };
}

async function launchGame(webContents, settings) {
  var user = getUser();
  if (!user) throw new Error('Utilisateur non connecté');

  sendStatus(webContents, 'installing', 'Préparation de Minecraft 1.20.1 Forge...');
  sendProgress(webContents, 'Initialisation...', 0, '');

  var javaPath = await resolveJavaPath(settings);
  if (!javaPath) {
    console.log('[Skyzer] Java 17+ introuvable, téléchargement automatique...');
    sendProgress(webContents, 'Installation de Java 17...', 0, 'Requis pour Minecraft 1.20.1');
    sendStatus(webContents, 'downloading', 'Installation de Java 17...');
    var javaResult = await downloadAndInstallJava(webContents);
    javaPath = javaResult.path;
  }

  var ramMax = settings.ram || 4;
  var ramMin = Math.max(1, Math.floor(ramMax / 2));
  var jvmArgs = settings.jvmArgs ? settings.jvmArgs.trim().split(/\s+/).filter(Boolean) : [];

  var launcher = new Launch();

  return new Promise(function (resolve, reject) {
    var launched = false;

    launcher.on('progress', function (progress, size, element) {
      var percent = size > 0 ? Math.round(progress / size * 100) : 0;
      sendProgress(webContents, 'Téléchargement Minecraft...', percent, element || '');
    });

    launcher.on('check', function (progress, size, element) {
      var percent = size > 0 ? Math.round(progress / size * 100) : 0;
      sendProgress(webContents, 'Vérification Minecraft...', percent, element || '');
    });

    launcher.on('extract', function (data) {
      sendProgress(webContents, 'Extraction...', -1, typeof data === 'string' ? data : '');
    });

    launcher.on('data', function (e) {
      if (!launched) {
        launched = true;
        gameProcess = launcher;
        sendStatus(webContents, 'playing', 'En jeu');
        if (settings.closeOnLaunch && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
        resolve();
      }
      if (typeof e === 'string' && e.trim()) console.log('[MC] ' + e.trim());
    });

    launcher.on('close', function (code) {
      console.log('[Skyzer] Minecraft fermé code ' + code);
      gameProcess = null;
      sendStatus(webContents, 'closed', 'Jeu fermé');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    });

    launcher.on('error', function (err) {
      var msg = typeof err === 'string' ? err : (err.error || (err instanceof Error ? err.message : JSON.stringify(err)));
      console.error('[Skyzer] Erreur lancement:', msg);
      if (!launched) { gameProcess = null; reject(new Error(msg)); }
      else { sendStatus(webContents, 'error', msg); gameProcess = null; }
    });

    var options = {
      authenticator: {
        access_token: user.accessToken,
        client_token: user.uuid,
        uuid: user.uuid,
        name: user.name,
        user_properties: '{}',
        meta: {
          type: 'msa',
          access_token: user.accessToken,
          demo: false,
          online: true,
        },
      },
      path: path.resolve(GAME_DIR).replace(/\\/g, '/'),
      version: MC_VERSION,
      detached: true,
      downloadFileMultiple: 4,
      loader: {
        type: 'forge',
        build: 'latest',
        enable: true,
      },
      verify: false,
      ignored: ['mods', 'config', 'resourcepacks', 'saves', 'screenshots', 'shaderpacks', 'schematics',
                'options.txt', 'servers.dat', 'usercache.json', 'realms_persistence.json',
                'logs', 'crash-reports', 'replay_recordings'],
      JVM_ARGS: jvmArgs,
      GAME_ARGS: [],
      java: { path: javaPath, type: 'jre' },
      screen: {},
      memory: { min: ramMin + 'G', max: ramMax + 'G' },
    };

    try {
      launcher.Launch(options);
    } catch (err) {
      reject(err);
    }

    // Safety timeout (5 minutes) for the first 'data' event
    setTimeout(function () {
      if (!launched) {
        gameProcess = null;
        reject(new Error('Le jeu n\'a pas démarré dans le délai imparti (5 min)'));
      }
    }, 300000);
  });
}

// ---------------------------------------------------------------------------
// Minecraft server ping (Java Edition status protocol)
// ---------------------------------------------------------------------------
function writeVarInt(value) {
  var bytes = [];
  do {
    var b = value & 0x7F;
    value >>>= 7;
    if (value !== 0) b |= 0x80;
    bytes.push(b);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  var result = 0, shift = 0, byte;
  do {
    if (offset >= buf.length) throw new Error('VarInt incomplete');
    byte = buf[offset++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, offset };
}

function pingMinecraftServer(host) {
  return new Promise(function (resolve) {
    var apiUrl = 'https://api.mcstatus.io/v2/status/java/' + encodeURIComponent(host);
    var req = https.get(apiUrl, { timeout: 8000 }, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try {
          var json = JSON.parse(data);
          if (json.online) {
            resolve({
              online: true,
              players: (json.players && json.players.online) || 0,
              max: (json.players && json.players.max) || 0,
              motd: '',
              latency: json.latency || 0,
            });
          } else {
            resolve({ online: false, players: 0, max: 0, motd: '', latency: 0 });
          }
        } catch (e) {
          resolve({ online: false, players: 0, max: 0, motd: '', latency: 0 });
        }
      });
    });
    req.on('error', function () { resolve({ online: false, players: 0, max: 0, motd: '', latency: 0 }); });
    req.on('timeout', function () { req.destroy(); resolve({ online: false, players: 0, max: 0, motd: '', latency: 0 }); });
  });
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  // Auth — Microsoft
  ipcMain.handle('auth:start-microsoft', async () => {
    try {
      const user = await startMsaAuth();
      saveUser(user);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.webContents.send('auth:token-received', user);
        createMainWindow();
      }
      return { success: true, user };
    } catch (e) {
      console.error('[Skyzer] auth:start-microsoft error:', e.message);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.webContents.send('auth:error', { message: e.message });
      }
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('auth:get-session', async () => {
    const user = getUser();
    if (!user || !user.accessToken) return { valid: false };
    if (user.expiresAt && user.expiresAt < Date.now()) { clearUser(); return { valid: false }; }
    return { valid: true, user };
  });

  ipcMain.handle('auth:logout', async () => {
    clearUser();
    return { success: true };
  });

  // App
  ipcMain.handle('app:get-version', async () => APP_VERSION);
  ipcMain.handle('app:is-dev', async () => !IS_PRODUCTION);
  ipcMain.handle('app:open-logs', async () => { shell.openPath(LOG_DIR); return { success: true }; });
  ipcMain.handle('app:quit', async () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
    else { isQuitting = true; app.quit(); }
  });
  ipcMain.handle('app:minimize', async () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.minimize(); });
  ipcMain.handle('app:maximize', async () => {
    const w = BrowserWindow.getFocusedWindow();
    if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
  });

  // Game
  ipcMain.handle('game:launch', async (event) => {
    var sender = event.sender;
    console.log('[Skyzer] Lancement demandé');
    if (gameProcess) return { success: false, error: 'Le jeu est déjà en cours d\'exécution' };
    try {
      var result = await checkAndDownloadGame(sender);
      // Si pas de manifeste ET pas de mods locaux → refuser le lancement
      if (!result.manifest) {
        var modsDir = path.join(GAME_DIR, 'mods');
        var hasLocalMods = fs.existsSync(modsDir) && fs.readdirSync(modsDir).some(function (f) { return f.endsWith('.jar'); });
        if (!hasLocalMods) {
          var offlineErr = 'Impossible de récupérer le manifeste et aucun mod local trouvé. Vérifiez votre connexion.';
          sendStatus(sender, 'error', offlineErr);
          return { success: false, error: offlineErr };
        }
      }
      var settings = store.get('settings', getDefaultSettings());
      await launchGame(sender, settings);
      return { success: true };
    } catch (err) {
      console.error('[Skyzer] game:launch erreur:', err.message);
      sendStatus(sender, 'error', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('game:repair', async (event) => {
    var sender = event.sender;
    console.log('[Skyzer] Réparation demandée');
    try {
      var manifestPath = path.join(GAME_DIR, '.skyzer-manifest.json');
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      sendStatus(sender, 'checking', 'Réparation en cours...');
      await checkAndDownloadGame(sender);
      sendStatus(sender, 'checking', 'Réparation terminée');
      return { success: true };
    } catch (err) {
      console.error('[Skyzer] game:repair erreur:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('game:fetch-manifest', async () => {
    try { return await fetchRemoteManifest(); } catch (err) { return null; }
  });

  // Settings
  ipcMain.handle('settings:get', async () => store.get('settings', getDefaultSettings()));
  ipcMain.handle('settings:save', async (event, settings) => { store.set('settings', settings); return { success: true }; });
  ipcMain.handle('settings:detect-java', async () => {
    try { return await autoDetectJava(); } catch (e) { return { found: false, path: '', version: '', error: e.message }; }
  });
  ipcMain.handle('settings:browse-java', async () => {
    var filters = process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [{ name: 'All Files', extensions: ['*'] }];
    var result = await dialog.showOpenDialog({ title: 'Sélectionner javaw.exe', filters, properties: ['openFile'] });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    var selectedPath = result.filePaths[0];
    var version = await getJavaVersion(selectedPath);
    return { canceled: false, path: selectedPath, version: version || '' };
  });
  ipcMain.handle('settings:browse-dir', async () => {
    var result = await dialog.showOpenDialog({ title: 'Répertoire du jeu', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  // Java
  ipcMain.handle('java:check', async () => {
    var settings = store.get('settings', {});
    if (settings.javaPath) {
      var version = await getJavaVersion(settings.javaPath);
      if (version) return { found: true, path: settings.javaPath, version };
    }
    return await autoDetectJava();
  });
  ipcMain.handle('java:download', async (event) => {
    try { var result = await downloadAndInstallJava(event.sender); return { success: true, path: result.path, version: result.version }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  // Shell
  ipcMain.handle('shell:open-external', async (event, urlStr) => {
    try { await shell.openExternal(urlStr); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  // Server status — ping Minecraft Java Edition via handshake TCP
  ipcMain.handle('server:status', async () => {
    return pingMinecraftServer('skyzerbeyondadventure.minesr.com');
  });

  // Map 3D — ouvre Bluemap dans une fenêtre in-launcher
  ipcMain.handle('map:open', async () => {
    var mapUrl = 'https://badlands.mystrator.com/s/fd0eefa1-2228-4eb7-9acf-9532150b1edd/#overworld:-326:40:-353:241:-1.84:0.85:0:0:perspective';
    var mapWin = new BrowserWindow({
      width: 1280, height: 800,
      title: 'Skyzer — Carte du monde',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    mapWin.loadURL(mapUrl);
    return { success: true };
  });

  // Nav
  ipcMain.handle('nav:go-main', async () => { createMainWindow(); });
  ipcMain.handle('nav:go-login', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.close(); mainWindow = null; }
    createLoginWindow();
  });

  // HWID
  ipcMain.handle('hwid:get', async () => collectHWID());

  // Window controls
  ipcMain.on('window:minimize', (event) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) w.minimize(); });
  ipcMain.on('window:maximize', (event) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } });
  ipcMain.on('window:close', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) {
      if (w === mainWindow) { if (!isQuitting) { w.hide(); return; } }
      w.close();
    }
  });

  // Auto-updater
  ipcMain.handle('update:check', async () => { try { autoUpdater.checkForUpdates(); return { success: true }; } catch (e) { return { success: false, error: e.message }; } });
  ipcMain.handle('update:install', async () => { autoUpdater.quitAndInstall(); });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  try {
    var trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) return;
    tray = new Tray(trayIcon);
    tray.setToolTip('Skyzer: Adventures Beyond');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Ouvrir le launcher', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); } },
      { type: 'separator' },
      { label: 'Quitter', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  } catch (e) {
    console.warn('[Skyzer] Tray creation failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    createSplashWindow();

    // Auto-updater — generic provider pour éviter la dépendance à la release "latest" Erinium
    try {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: SITE_URL + '/api/skyzer/update',
        channel: 'skyzer',
      });
      autoUpdater.on('checking-for-update', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:checking'); });
      autoUpdater.on('update-available', (info) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:available', info); });
      autoUpdater.on('update-not-available', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:not-available'); });
      autoUpdater.on('download-progress', (p) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:download-progress', p); });
      autoUpdater.on('update-downloaded', (info) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:downloaded', info); });
      autoUpdater.on('error', (err) => { console.error('[Skyzer] AutoUpdater error:', err.message); });
      if (IS_PRODUCTION) setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (e) {} }, 5000);
    } catch (e) { console.warn('[Skyzer] AutoUpdater setup failed:', e.message); }

    // Check session
    setTimeout(async () => {
      try {
        const user = getUser();
        if (user && user.accessToken && (!user.expiresAt || user.expiresAt > Date.now())) {
          console.log('[Skyzer] Session restaurée pour ' + user.name);
          createMainWindow();
        } else {
          if (user) { clearUser(); console.log('[Skyzer] Session expirée'); }
          createLoginWindow();
        }
      } catch (e) {
        console.error('[Skyzer] Session check error:', e.message);
        createLoginWindow();
      }

      // Create tray after windows
      createTray();
    }, 1500);
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') { /* keep alive for tray */ } });
  app.on('before-quit', () => { isQuitting = true; });
  app.on('activate', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
}
