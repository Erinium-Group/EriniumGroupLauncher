const { app, BrowserWindow, ipcMain, shell, safeStorage, nativeImage, Tray, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const https = require('https');
const url = require('url');
const os = require('os');
const { execFile, spawn } = require('child_process');
const Store = require('electron-store');
const { machineIdSync } = require('node-machine-id');
const { Launch } = require('minecraft-java-core');

// ---------------------------------------------------------------------------
// File logger — writes all console output to a log file
// ---------------------------------------------------------------------------
// Use APPDATA directly instead of app.getPath() which may not be ready yet
var LOG_DIR = path.join(
  process.env.APPDATA || process.env.HOME || os.homedir(),
  'eriniumfaction-launcher', 'logs'
);
var LOG_FILE = path.join(LOG_DIR, 'launcher.log');
var logStream = null;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Rotate log if > 2MB
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
    var oldLog = LOG_FILE + '.old';
    try { fs.unlinkSync(oldLog); } catch (e) {}
    fs.renameSync(LOG_FILE, oldLog);
  }

  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch (e) {
  // Last resort fallback
}

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

console.log('=== EriniumFaction Launcher started ===');
console.log('Version: ' + require('./package.json').version);
console.log('Platform: ' + process.platform + ' ' + process.arch);
console.log('Packaged: ' + app.isPackaged);
console.log('Log file: ' + LOG_FILE);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SITE_URL = 'https://eriniumfaction.vercel.app';
const MANIFEST_URL = SITE_URL + '/api/launcher/manifest';
const APP_VERSION = require('./package.json').version;
const MC_VERSION = '1.12.2';
const GAME_DIR = path.join(app.getPath('appData'), '.eriniumfaction');
const MC_DIR = path.join(GAME_DIR, 'minecraft');
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_RETRIES = 3;
const FILE_TIMEOUT = 60000;

let store;
try {
  store = new Store({
    name: 'erinium-launcher',
    encryptionKey: crypto.createHash('sha256').update('erinium-' + (machineIdSync(true) || 'default')).digest('hex'),
  });
} catch (e) {
  // Store corrupted (e.g. encryption key changed) — delete and recreate
  const storePath = path.join(app.getPath('userData'), 'erinium-launcher.json');
  try { fs.unlinkSync(storePath); } catch (_) {}
  store = new Store({
    name: 'erinium-launcher',
    encryptionKey: crypto.createHash('sha256').update('erinium-' + (machineIdSync(true) || 'default')).digest('hex'),
  });
}

let mainWindow = null;
let splashWindow = null;
let loginWindow = null;
let currentUser = null;
let callbackServer = null;
let oauthState = null;
let tray = null;
let isQuitting = false;
const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const IS_PRODUCTION = app.isPackaged;

// ---------------------------------------------------------------------------
// HWID collection
// ---------------------------------------------------------------------------
function collectHWID() {
  try {
    return machineIdSync(true);
  } catch (e) {
    const cpuModel = os.cpus()[0] ? os.cpus()[0].model : 'unknown';
    const platform = os.platform() + os.arch();
    const totalMem = os.totalmem().toString();
    const raw = cpuModel + '|' + platform + '|' + totalMem;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------
function saveTokens(jwt, refreshToken) {
  if (safeStorage.isEncryptionAvailable()) {
    store.set('jwt', safeStorage.encryptString(jwt).toString('base64'));
    store.set('refreshToken', safeStorage.encryptString(refreshToken).toString('base64'));
  } else {
    store.set('jwt', jwt);
    store.set('refreshToken', refreshToken);
  }
}

function getToken(key) {
  const val = store.get(key);
  if (!val) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(val, 'base64'));
    }
    return val;
  } catch (e) {
    return null;
  }
}

function clearTokens() {
  store.delete('jwt');
  store.delete('refreshToken');
  store.delete('user');
  currentUser = null;
}

function saveUser(user) {
  store.set('user', user);
  currentUser = user;
}

function getUser() {
  if (currentUser) return currentUser;
  const u = store.get('user');
  if (u) currentUser = u;
  return u || null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function fetchJSON(urlStr, headers) {
  return new Promise((resolve) => {
    function doFetch(reqUrl, redirectCount) {
      if (redirectCount > 5) return resolve(null);
      var mod = reqUrl.startsWith('https') ? https : http;
      var options = { timeout: 8000 };
      if (headers && typeof headers === 'object') {
        options.headers = headers;
      }
      var req = mod.get(reqUrl, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var loc = res.headers.location;
          if (!loc.startsWith('http')) {
            loc = new url.URL(loc, reqUrl).toString();
          }
          return doFetch(loc, redirectCount + 1);
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    }
    doFetch(urlStr, 0);
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
  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
  });
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
    backgroundColor: '#0A0A12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !IS_PRODUCTION,
    },
  });

  loginWindow.loadFile(path.join(__dirname, 'src', 'login', 'login.html'));
  loginWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
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
    backgroundColor: '#0A0A12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !IS_PRODUCTION,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'main', 'main.html'));
  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.close();
      loginWindow = null;
    }
    mainWindow.show();
  });

  // X button hides to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ---------------------------------------------------------------------------
// OAuth callback server
// ---------------------------------------------------------------------------
function startOAuthCallbackServer() {
  return new Promise((resolve, reject) => {
    oauthState = crypto.randomBytes(32).toString('hex');
    callbackServer = http.createServer((req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname === '/callback') {
        const { token, refresh, state, error, username, discordName, discordAvatar, discordId, mcName } = parsed.query;

        // Send a nice HTML page to the browser
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>EriniumFaction</title>
          <style>body{background:#0A0A12;color:#F0F2FF;font-family:Inter,sans-serif;display:flex;
          align-items:center;justify-content:center;height:100vh;margin:0;}
          .box{text-align:center;}.ok{color:#2ECC71;font-size:24px;font-weight:700;}
          p{color:#8892A4;margin-top:12px;}</style></head>
          <body><div class="box"><div class="ok">Connexion reussie !</div>
          <p>Vous pouvez fermer cet onglet et retourner au launcher.</p></div></body></html>`);

        // Close server
        callbackServer.close();
        callbackServer = null;

        if (error) {
          if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.webContents.send('auth:error', { message: error });
          }
          return;
        }

        if (token && refresh) {
          saveTokens(token, refresh);
          const user = parseJwtPayload(token) || {};
          // Enrich with query params from the site callback
          if (username) user.username = username;
          if (discordName) user.discordName = discordName;
          if (discordAvatar) user.avatar = discordAvatar;
          if (discordId) user.discordId = discordId;
          if (mcName) user.mcName = mcName;
          saveUser(user);
          if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.webContents.send('auth:token-received', user);
            // Transition to main window
            createMainWindow();
          }
        }
      }
    });

    callbackServer.listen(0, '127.0.0.1', () => {
      const port = callbackServer.address().port;
      resolve(port);
    });

    callbackServer.on('error', (err) => {
      reject(err);
    });
  });
}

function parseJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dev login (simulated auth for development)
// ---------------------------------------------------------------------------
function devLogin() {
  const fakeUser = {
    mcName: 'DevPlayer',
    discordName: 'DevPlayer#1234',
    discordId: '123456789012345678',
    avatar: null,
    rank: 'Admin',
    rankColor: '#E74C3C',
    faction: 'DevFaction',
    kills: 142,
    deaths: 87,
    exp: Date.now() + 3600000,
  };
  const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify(fakeUser)).toString('base64').replace(/=/g, '') +
    '.fakesignature';
  const fakeRefresh = 'fake-refresh-token-' + Date.now();
  saveTokens(fakeJwt, fakeRefresh);
  saveUser(fakeUser);
  return fakeUser;
}

// ---------------------------------------------------------------------------
// Java detection & download helpers
// ---------------------------------------------------------------------------
function getJavaVersion(javaPath) {
  return new Promise(function (resolve) {
    execFile(javaPath, ['-version'], function (err, stdout, stderr) {
      if (err) return resolve(null);
      // java -version outputs to stderr
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
  // Handle "21.0.3", "1.8.0_482", etc.
  var parts = versionStr.split(/[._-]/);
  var major = parseInt(parts[0], 10);
  if (major === 1 && parts.length > 1) return parseInt(parts[1], 10); // 1.8 -> 8
  return major;
}

/**
 * Get the java binary name for the current platform.
 * Windows: javaw.exe (preferred) or java.exe
 * macOS/Linux: java
 */
function getJavaBinaryName() {
  return process.platform === 'win32' ? 'javaw.exe' : 'java';
}

function getJavaBinaryFallback() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function findJavaExecutables() {
  var candidates = [];
  var env = process.env;
  var isWin = process.platform === 'win32';
  var isMac = process.platform === 'darwin';
  var binName = getJavaBinaryName();
  var binFallback = getJavaBinaryFallback();

  // JAVA_HOME (all platforms)
  if (env.JAVA_HOME) {
    candidates.push(path.join(env.JAVA_HOME, 'bin', binName));
    if (binName !== binFallback) candidates.push(path.join(env.JAVA_HOME, 'bin', binFallback));
  }

  // Our own downloaded Java (all platforms)
  var ownJavaDir = path.join(app.getPath('appData'), '.eriniumfaction', 'java');

  // Platform-specific search directories
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
      '/usr/local/opt/openjdk',
      '/opt/homebrew/opt/openjdk'
    );
  } else {
    // Linux
    searchDirs.push(
      '/usr/lib/jvm',
      '/usr/java',
      '/opt/java',
      path.join(os.homedir(), '.sdkman', 'candidates', 'java')
    );
  }

  searchDirs.forEach(function (dir) {
    try {
      if (!fs.existsSync(dir)) return;
      var entries = fs.readdirSync(dir);
      entries.forEach(function (entry) {
        // macOS JVMs are in Contents/Home/bin/
        var binDir = path.join(dir, entry, 'bin');
        var macBin = path.join(dir, entry, 'Contents', 'Home', 'bin');
        var dirs = [binDir, macBin];
        for (var d = 0; d < dirs.length; d++) {
          var javaBin = path.join(dirs[d], binName);
          var javaFallback = path.join(dirs[d], binFallback);
          if (fs.existsSync(javaBin)) { candidates.push(javaBin); break; }
          else if (fs.existsSync(javaFallback)) { candidates.push(javaFallback); break; }
        }
      });
    } catch (e) { /* ignore permission errors */ }
  });

  // System PATH lookup
  try {
    var cmd = isWin ? 'where javaw.exe 2>nul' : 'which java 2>/dev/null';
    var result = require('child_process').execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    result.split('\n').forEach(function (line) {
      var p = line.trim();
      if (p && fs.existsSync(p)) candidates.push(p);
    });
  } catch (e) { /* not in PATH */ }

  // Deduplicate
  var seen = {};
  return candidates.filter(function (c) {
    var norm = path.resolve(c);
    if (!isWin) norm = norm; // case-sensitive on unix
    else norm = norm.toLowerCase();
    if (seen[norm]) return false;
    seen[norm] = true;
    return fs.existsSync(c);
  });
}

async function autoDetectJava() {
  var candidates = findJavaExecutables();
  var results = [];

  for (var i = 0; i < candidates.length; i++) {
    var javaPath = candidates[i];
    var version = await getJavaVersion(javaPath);
    if (version) {
      results.push({ path: javaPath, version: version, major: getMajorVersion(version) });
    }
  }

  // Prefer Java 25+ (CleanRoom), then highest version
  results.sort(function (a, b) {
    var aPreferred = a.major >= 25 ? 1 : 0;
    var bPreferred = b.major >= 25 ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    return b.major - a.major;
  });

  if (results.length > 0) {
    return { found: true, path: results[0].path, version: results[0].version };
  }
  return { found: false, path: '', version: '' };
}

function downloadFile(downloadUrl, destPath, progressCallback) {
  return new Promise(function (resolve, reject) {
    var mod = downloadUrl.startsWith('https') ? https : http;

    function doRequest(reqUrl, redirectCount) {
      if (redirectCount > 10) return reject(new Error('Trop de redirections'));

      var currentMod = reqUrl.startsWith('https') ? https : http;
      currentMod.get(reqUrl, { timeout: 30000 }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var newUrl = res.headers.location;
          // Resolve relative redirects
          if (!newUrl.startsWith('http')) {
            newUrl = new url.URL(newUrl, reqUrl).toString();
          }
          return doRequest(newUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error('Erreur HTTP ' + res.statusCode));
        }

        var totalSize = parseInt(res.headers['content-length'], 10) || 0;
        var downloaded = 0;
        var file = fs.createWriteStream(destPath);

        res.on('data', function (chunk) {
          downloaded += chunk.length;
          file.write(chunk);
          if (progressCallback && totalSize > 0) {
            progressCallback({
              downloaded: downloaded,
              total: totalSize,
              percent: Math.round((downloaded / totalSize) * 100),
            });
          }
        });

        res.on('end', function () {
          file.end(function () {
            resolve(destPath);
          });
        });

        res.on('error', function (err) {
          file.close();
          try { fs.unlinkSync(destPath); } catch (e) {}
          reject(err);
        });
      }).on('error', reject).on('timeout', function () {
        reject(new Error('Timeout lors du telechargement'));
      });
    }

    doRequest(downloadUrl, 0);
  });
}

async function extractArchive(archivePath, destDir) {
  return new Promise(function (resolve, reject) {
    var cmd, args;

    if (process.platform === 'win32') {
      // PowerShell Expand-Archive for .zip
      cmd = 'powershell.exe';
      args = [
        '-NoProfile', '-Command',
        'Expand-Archive -Path "' + archivePath.replace(/\\/g, '\\\\') + '" -DestinationPath "' + destDir.replace(/\\/g, '\\\\') + '" -Force'
      ];
    } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      cmd = 'tar';
      args = ['xzf', archivePath, '-C', destDir];
    } else {
      // .zip on mac/linux
      cmd = 'unzip';
      args = ['-o', archivePath, '-d', destDir];
    }

    execFile(cmd, args, { timeout: 120000 }, function (err, stdout, stderr) {
      if (err) return reject(new Error('Extraction echouee: ' + (stderr || err.message)));
      resolve();
    });
  });
}

async function downloadAndInstallJava(senderWebContents) {
  var javaBaseDir = path.join(app.getPath('appData'), '.eriniumfaction', 'java');

  // Create directory
  try {
    fs.mkdirSync(javaBaseDir, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  // Determine OS and arch for Adoptium API
  var adoptiumOs, adoptiumArch, archiveExt;
  switch (process.platform) {
    case 'win32':  adoptiumOs = 'windows'; break;
    case 'darwin': adoptiumOs = 'mac';     break;
    default:       adoptiumOs = 'linux';   break;
  }
  switch (process.arch) {
    case 'arm64':  adoptiumArch = 'aarch64'; break;
    case 'arm':    adoptiumArch = 'arm';     break;
    default:       adoptiumArch = 'x64';     break;
  }
  // Windows = .zip, macOS/Linux = .tar.gz
  archiveExt = process.platform === 'win32' ? '.zip' : '.tar.gz';

  var archivePath = path.join(javaBaseDir, 'jdk-download' + archiveExt);
  var downloadUrl = 'https://api.adoptium.net/v3/binary/latest/25/ga/' + adoptiumOs + '/' + adoptiumArch + '/jdk/hotspot/normal/eclipse?project=jdk';

  // Download
  function sendProgress(data) {
    if (senderWebContents && !senderWebContents.isDestroyed()) {
      senderWebContents.send('java:download-progress', data);
    }
  }

  sendProgress({ status: 'downloading', percent: 0, message: 'Telechargement de Java 25...' });

  try {
    await downloadFile(downloadUrl, archivePath, function (p) {
      sendProgress({
        status: 'downloading',
        percent: p.percent,
        downloaded: p.downloaded,
        total: p.total,
        message: 'Telechargement... ' + p.percent + '%',
      });
    });
  } catch (err) {
    sendProgress({ status: 'error', message: 'Echec du telechargement: ' + err.message });
    throw err;
  }

  // Extract
  sendProgress({ status: 'extracting', percent: 100, message: 'Extraction en cours...' });

  try {
    await extractArchive(archivePath, javaBaseDir);
  } catch (err) {
    sendProgress({ status: 'error', message: 'Echec de l\'extraction: ' + err.message });
    throw err;
  }

  // Clean up archive
  try { fs.unlinkSync(archivePath); } catch (e) {}

  // Find the extracted JDK directory (e.g. jdk-21.0.x+y)
  // macOS: Contents/Home/bin/java, Linux/Win: bin/java
  var binName = getJavaBinaryName();
  var entries = fs.readdirSync(javaBaseDir);
  var jdkDir = null;
  var javaBinPath = null;

  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].startsWith('jdk-')) continue;
    var base = path.join(javaBaseDir, entries[i]);

    // Direct: bin/java or bin/javaw.exe
    var direct = path.join(base, 'bin', binName);
    if (fs.existsSync(direct)) {
      jdkDir = base;
      javaBinPath = direct;
      break;
    }
    // macOS: Contents/Home/bin/java
    var macPath = path.join(base, 'Contents', 'Home', 'bin', binName);
    if (fs.existsSync(macPath)) {
      jdkDir = path.join(base, 'Contents', 'Home');
      javaBinPath = macPath;
      break;
    }
    // Fallback: java.exe on windows
    var fallback = path.join(base, 'bin', getJavaBinaryFallback());
    if (fs.existsSync(fallback)) {
      jdkDir = base;
      javaBinPath = fallback;
      break;
    }
  }

  if (!javaBinPath) {
    sendProgress({ status: 'error', message: 'Impossible de trouver Java apres extraction' });
    throw new Error('Java introuvable apres extraction');
  }

  var version = await getJavaVersion(javaBinPath);

  sendProgress({ status: 'done', percent: 100, message: 'Java 25 installe avec succes !', path: javaBinPath, version: version || '25' });

  return { path: javaBinPath, version: version || '25' };
}

// ---------------------------------------------------------------------------
// Game Management — Download, Verify, Launch
// ---------------------------------------------------------------------------

// Track the running game process
let gameProcess = null;

/**
 * Send a progress update to the renderer.
 */
function sendProgress(webContents, step, percent, detail) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send('game:progress', { step: step, percent: percent, detail: detail || '' });
  }
}

/**
 * Send a status update to the renderer.
 */
function sendStatus(webContents, status, message) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send('game:status', { status: status, message: message || '' });
  }
}

/**
 * Compute SHA-256 hash of a file using streaming.
 */
function hashFile(filePath) {
  return new Promise(function (resolve, reject) {
    var hash = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath);
    stream.on('data', function (chunk) { hash.update(chunk); });
    stream.on('end', function () { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}

/**
 * Verify a file's SHA-256 hash matches expected.
 */
async function verifyFile(filePath, expectedHash) {
  try {
    if (!fs.existsSync(filePath)) return false;
    var actual = await hashFile(filePath);
    return actual === expectedHash;
  } catch (e) {
    return false;
  }
}

/**
 * Ensure a directory exists (recursive).
 */
function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

/**
 * Fetch remote manifest JSON.
 */
function fetchRemoteManifest() {
  return fetchJSON(MANIFEST_URL);
}

/**
 * Load local manifest from disk.
 */
function loadLocalManifest() {
  var manifestPath = path.join(GAME_DIR, 'manifest.json');
  try {
    if (!fs.existsSync(manifestPath)) return null;
    var data = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

/**
 * Save manifest to disk.
 */
function saveLocalManifest(manifest) {
  var manifestPath = path.join(GAME_DIR, 'manifest.json');
  ensureDir(GAME_DIR);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Compare remote and local manifests, return list of files to download.
 * Also returns files to delete (present locally but removed from remote).
 */
async function compareManifests(remote, local) {
  var toDownload = [];
  var toDelete = [];

  if (!remote || !remote.files) return { toDownload: toDownload, toDelete: toDelete };

  // Build lookup of local files by path
  var localMap = {};
  if (local && local.files) {
    for (var i = 0; i < local.files.length; i++) {
      localMap[local.files[i].path] = local.files[i];
    }
  }

  // Check each remote file against what's actually on disk
  console.log('[EriniumFaction] Comparing ' + remote.files.length + ' remote files against local disk...');
  for (var j = 0; j < remote.files.length; j++) {
    var remoteFile = remote.files[j];
    var fullPath = path.join(GAME_DIR, remoteFile.path);

    if (!fs.existsSync(fullPath)) {
      console.log('[EriniumFaction]   MISSING: ' + remoteFile.path);
      toDownload.push(remoteFile);
    } else {
      var localHash = await hashFile(fullPath);
      if (localHash !== remoteFile.sha256) {
        var localSize = fs.statSync(fullPath).size;
        console.log('[EriniumFaction]   CHANGED: ' + remoteFile.path + ' (local: ' + localSize + 'b/' + localHash.substring(0, 12) + '... remote: ' + remoteFile.size + 'b/' + remoteFile.sha256.substring(0, 12) + '...)');
        toDownload.push(remoteFile);
      }
    }

    // Remove from localMap so we can find deletions
    delete localMap[remoteFile.path];
  }
  console.log('[EriniumFaction] Result: ' + toDownload.length + ' to download, checking deletions...');

  // Files in local but not in remote should be deleted (for mods/ only)
  var remainingKeys = Object.keys(localMap);
  for (var k = 0; k < remainingKeys.length; k++) {
    var oldFile = localMap[remainingKeys[k]];
    if (oldFile.category === 'mod') {
      toDelete.push(oldFile);
    }
  }

  return { toDownload: toDownload, toDelete: toDelete };
}

/**
 * Download a single file with retry logic.
 * Files are downloaded to .tmp and renamed after hash verification.
 */
function downloadGameFile(fileUrl, destPath, expectedHash, progressCallback) {
  return new Promise(function (resolve, reject) {
    var tmpPath = destPath + '.tmp';
    ensureDir(path.dirname(destPath));

    var attempt = 0;

    function tryDownload() {
      attempt++;
      var mod = fileUrl.startsWith('https') ? https : http;

      function doRequest(reqUrl, redirectCount) {
        if (redirectCount > 10) return reject(new Error('Trop de redirections'));

        var currentMod = reqUrl.startsWith('https') ? https : http;
        currentMod.get(reqUrl, { timeout: FILE_TIMEOUT }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            var loc = res.headers.location;
            if (!loc.startsWith('http')) {
              loc = new url.URL(loc, reqUrl).toString();
            }
            return doRequest(loc, redirectCount + 1);
          }

          if (res.statusCode !== 200) {
            if (attempt < MAX_RETRIES) {
              var delay = Math.pow(2, attempt) * 1000;
              setTimeout(tryDownload, delay);
              return;
            }
            return reject(new Error('Erreur HTTP ' + res.statusCode + ' pour ' + fileUrl));
          }

          var totalSize = parseInt(res.headers['content-length'], 10) || 0;
          var downloaded = 0;
          var file = fs.createWriteStream(tmpPath);

          res.on('data', function (chunk) {
            downloaded += chunk.length;
            file.write(chunk);
            if (progressCallback && totalSize > 0) {
              progressCallback({
                downloaded: downloaded,
                total: totalSize,
                percent: Math.round((downloaded / totalSize) * 100),
              });
            }
          });

          res.on('end', function () {
            file.end(function () {
              // Verify hash
              if (expectedHash) {
                hashFile(tmpPath).then(function (actualHash) {
                  if (actualHash !== expectedHash) {
                    // Hash mismatch — retry
                    try { fs.unlinkSync(tmpPath); } catch (e) {}
                    if (attempt < MAX_RETRIES) {
                      var delay = Math.pow(2, attempt) * 1000;
                      setTimeout(tryDownload, delay);
                    } else {
                      reject(new Error('Hash mismatch pour ' + destPath + ' apres ' + MAX_RETRIES + ' tentatives'));
                    }
                  } else {
                    // Rename .tmp to final
                    try {
                      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                      fs.renameSync(tmpPath, destPath);
                    } catch (e) {
                      reject(new Error('Impossible de finaliser ' + destPath + ': ' + e.message));
                      return;
                    }
                    resolve(destPath);
                  }
                }).catch(function (err) {
                  try { fs.unlinkSync(tmpPath); } catch (e) {}
                  reject(err);
                });
              } else {
                // No hash check — just rename
                try {
                  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                  fs.renameSync(tmpPath, destPath);
                } catch (e) {
                  reject(new Error('Impossible de finaliser ' + destPath + ': ' + e.message));
                  return;
                }
                resolve(destPath);
              }
            });
          });

          res.on('error', function (err) {
            file.close();
            try { fs.unlinkSync(tmpPath); } catch (e) {}
            if (attempt < MAX_RETRIES) {
              var delay = Math.pow(2, attempt) * 1000;
              setTimeout(tryDownload, delay);
            } else {
              reject(err);
            }
          });
        }).on('error', function (err) {
          if (attempt < MAX_RETRIES) {
            var delay = Math.pow(2, attempt) * 1000;
            setTimeout(tryDownload, delay);
          } else {
            reject(err);
          }
        }).on('timeout', function () {
          if (attempt < MAX_RETRIES) {
            var delay = Math.pow(2, attempt) * 1000;
            setTimeout(tryDownload, delay);
          } else {
            reject(new Error('Timeout pour ' + fileUrl));
          }
        });
      }

      doRequest(fileUrl, 0);
    }

    tryDownload();
  });
}

/**
 * Download manifest files with parallel downloads and progress reporting.
 */
async function downloadManifestFiles(files, webContents) {
  if (!files || files.length === 0) return;

  var totalBytes = 0;
  var downloadedBytes = 0;
  var completedFiles = 0;
  var totalFiles = files.length;
  var startTime = Date.now();
  var lastProgressTime = 0;

  for (var i = 0; i < files.length; i++) {
    totalBytes += (files[i].size || 0);
  }

  // Process files in batches of MAX_CONCURRENT_DOWNLOADS
  var queue = files.slice();
  var errors = [];

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

          // Throttle progress updates to every 200ms
          var now = Date.now();
          if (now - lastProgressTime >= 200) {
            lastProgressTime = now;
            var elapsed = (now - startTime) / 1000;
            var speed = elapsed > 0 ? downloadedBytes / elapsed : 0;
            var remaining = speed > 0 ? (totalBytes - downloadedBytes) / speed : 0;
            var globalPercent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;

            var detail = completedFiles + '/' + totalFiles + ' fichiers (' + globalPercent + '%)';
            if (speed > 0) {
              detail += ' — ' + formatBytes(speed) + '/s';
            }
            if (remaining > 0 && remaining < 99999) {
              detail += ' — ~' + Math.ceil(remaining) + 's restantes';
            }

            sendProgress(webContents, 'Telechargement...', globalPercent, detail);
          }
        }).then(function () {
          completedFiles++;
        }).catch(function (err) {
          errors.push({ file: file.path, error: err.message });
          console.error('[EriniumFaction] Echec telechargement ' + file.path + ':', err.message);
        });

        promises.push(promise);
      })(batch[j]);
    }

    await Promise.all(promises);
  }

  if (errors.length > 0) {
    var requiredErrors = errors.filter(function (e) {
      var matchingFile = files.find(function (f) { return f.path === e.file; });
      return matchingFile && matchingFile.required;
    });
    if (requiredErrors.length > 0) {
      throw new Error('Echec du telechargement de ' + requiredErrors.length + ' fichier(s) requis: ' + requiredErrors.map(function (e) { return e.file; }).join(', '));
    }
  }
}

/**
 * Format bytes to human readable string.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' Mo';
  return (bytes / 1073741824).toFixed(1) + ' Go';
}

/**
 * Sync optional mods: download enabled ones, delete disabled ones.
 */
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
      // Download if not present or hash mismatch
      if (!fs.existsSync(localPath)) {
        console.log('[EriniumFaction] Downloading optional mod: ' + fileName);
        if (mod.url) {
          try {
            await downloadFile(mod.url, localPath);
            console.log('[EriniumFaction] Optional mod downloaded: ' + fileName);
          } catch (err) {
            console.warn('[EriniumFaction] Failed to download optional mod: ' + fileName, err.message);
          }
        }
      } else {
        // Verify hash
        var localHash = await hashFile(localPath);
        if (localHash !== mod.sha256) {
          console.log('[EriniumFaction] Optional mod hash mismatch, re-downloading: ' + fileName);
          try { fs.unlinkSync(localPath); } catch (e) {}
          if (mod.url) {
            try {
              await downloadFile(mod.url, localPath);
            } catch (err) {
              console.warn('[EriniumFaction] Failed to re-download optional mod: ' + fileName, err.message);
            }
          }
        }
      }
    } else {
      // Disabled — remove if present
      if (fs.existsSync(localPath)) {
        try {
          fs.unlinkSync(localPath);
          console.log('[EriniumFaction] Optional mod removed: ' + fileName);
        } catch (e) {
          console.warn('[EriniumFaction] Could not remove optional mod: ' + fileName, e.message);
        }
      }
    }
  }
}

/**
 * Check the mods/ whitelist: move unauthorized jars to mods_disabled/.
 */
function enforceModsWhitelist(manifest, gameDir) {
  var modsDir = path.join(gameDir || GAME_DIR, 'mods');
  if (!fs.existsSync(modsDir)) return [];

  var allowedFiles = {};
  if (manifest && manifest.files) {
    for (var i = 0; i < manifest.files.length; i++) {
      if (manifest.files[i].category === 'mod') {
        allowedFiles[path.basename(manifest.files[i].path)] = true;
      }
    }
  }
  // Also allow optional mods from the allowedMods list
  if (manifest && manifest.allowedMods) {
    for (var k = 0; k < manifest.allowedMods.length; k++) {
      allowedFiles[path.basename(manifest.allowedMods[k].path)] = true;
    }
  }

  var disabledDir = path.join(GAME_DIR, 'mods_disabled');
  var movedFiles = [];

  try {
    var entries = fs.readdirSync(modsDir);
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (!entry.endsWith('.jar')) continue;
      if (allowedFiles[entry]) continue;

      // Unauthorized mod — DELETE it
      var src = path.join(modsDir, entry);
      try {
        fs.unlinkSync(src);
        movedFiles.push(entry);
        console.log('[EriniumFaction] Mod non autorise SUPPRIME: ' + entry);
      } catch (e) {
        console.warn('[EriniumFaction] Impossible de supprimer ' + entry + ':', e.message);
      }
    }
  } catch (e) {
    console.warn('[EriniumFaction] Erreur lors du scan du dossier mods/:', e.message);
  }

  return movedFiles;
}

/**
 * Delete files that were removed from the manifest.
 */
function deleteRemovedFiles(filesToDelete) {
  for (var i = 0; i < filesToDelete.length; i++) {
    var fullPath = path.join(GAME_DIR, filesToDelete[i].path);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log('[EriniumFaction] Fichier supprime (retire du manifeste): ' + filesToDelete[i].path);
      }
    } catch (e) {
      console.warn('[EriniumFaction] Impossible de supprimer ' + filesToDelete[i].path + ':', e.message);
    }
  }
}

/**
 * Clean up .tmp files from interrupted downloads.
 */
function cleanupTmpFiles() {
  var dirs = ['mods', 'config', 'resourcepacks', 'cleanroom'];
  for (var i = 0; i < dirs.length; i++) {
    var dir = path.join(GAME_DIR, dirs[i]);
    try {
      if (!fs.existsSync(dir)) continue;
      var entries = fs.readdirSync(dir);
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].endsWith('.tmp')) {
          fs.unlinkSync(path.join(dir, entries[j]));
        }
      }
    } catch (e) {}
  }
}

/**
 * Download Minecraft vanilla via minecraft-java-core (download only, no launch).
 */
function downloadMinecraftVanilla(webContents, settings) {
  return new Promise(function (resolve, reject) {
    var launcher = new Launch();

    var javaPath = (settings && settings.javaPath) ? settings.javaPath : null;
    var ramMax = (settings && settings.ram) ? settings.ram + 'G' : '4G';
    var ramMin = '1G';

    var opt = {
      authenticator: {
        access_token: 'offline',
        client_token: 'offline',
        uuid: '00000000-0000-0000-0000-000000000000',
        name: 'Player',
        user_properties: '{}',
        meta: { type: 'Mojang', online: false },
      },
      path: MC_DIR,
      version: MC_VERSION,
      detached: false,
      downloadFileMultiple: 5,
      loader: {
        type: null,
        build: 'latest',
        enable: false,
      },
      verify: false,
      ignored: [],
      JVM_ARGS: [],
      GAME_ARGS: [],
      java: javaPath ? { path: javaPath, type: 'jre' } : { type: 'jre' },
      screen: {},
      memory: { min: ramMin, max: ramMax },
    };

    // We only want to download, not launch.
    // Use DownloadGame() directly.
    launcher.options = {
      url: null,
      authenticator: opt.authenticator,
      timeout: 10000,
      path: path.resolve(MC_DIR).replace(/\\/g, '/'),
      version: MC_VERSION,
      instance: null,
      detached: false,
      intelEnabledMac: false,
      ignore_log4j: false,
      downloadFileMultiple: 5,
      bypassOffline: false,
      loader: { path: './loader', type: null, build: 'latest', enable: false },
      mcp: null,
      verify: false,
      ignored: [],
      JVM_ARGS: [],
      GAME_ARGS: [],
      java: javaPath ? { path: javaPath, type: 'jre' } : { type: 'jre' },
      screen: { width: null, height: null, fullscreen: false },
      memory: { min: ramMin, max: ramMax },
    };

    launcher.on('progress', function (progress, size, element) {
      var percent = size > 0 ? Math.round((progress / size) * 100) : 0;
      sendProgress(webContents, 'Telechargement de Minecraft...', percent, element || '');
    });

    launcher.on('check', function (progress, size, element) {
      var percent = size > 0 ? Math.round((progress / size) * 100) : 0;
      sendProgress(webContents, 'Verification de Minecraft...', percent, element || '');
    });

    launcher.on('extract', function (extractData) {
      sendProgress(webContents, 'Extraction...', -1, typeof extractData === 'string' ? extractData : '');
    });

    launcher.on('error', function (err) {
      console.error('[EriniumFaction] MC download error:', err);
      reject(new Error(err.error || err.message || 'Erreur telechargement Minecraft'));
    });

    launcher.DownloadGame().then(function (data) {
      if (!data) {
        reject(new Error('Echec du telechargement de Minecraft vanilla'));
        return;
      }
      resolve(data);
    }).catch(function (err) {
      reject(err);
    });
  });
}

/**
 * Find the CleanRoom universal jar in GAME_DIR.
 * Looks for the version profile JSON that the installer creates,
 * then falls back to scanning for any universal jar.
 */
function getCleanRoomJarPath(manifest) {
  var version = (manifest && manifest.cleanroom) || '0.5.7-alpha';
  var versionDir = path.join(GAME_DIR, 'versions', 'cleanroom-' + version);

  // After installer runs, the universal jar is in GAME_DIR root or versions dir
  // Check versions/<id>/<id>.jar first (standard Forge/CleanRoom layout)
  var versionJar = path.join(versionDir, 'cleanroom-' + version + '.jar');
  if (fs.existsSync(versionJar)) return versionJar;

  // Check GAME_DIR/libraries for the universal jar
  var libCleanroom = path.join(GAME_DIR, 'libraries', 'net', 'cleanroommc', 'cleanroom', version);
  if (fs.existsSync(libCleanroom)) {
    try {
      var entries = fs.readdirSync(libCleanroom);
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].endsWith('.jar')) return path.join(libCleanroom, entries[i]);
      }
    } catch (e) {}
  }

  // Fallback: find any universal jar in cleanroom/ dir
  var cleanroomDir = path.join(GAME_DIR, 'cleanroom');
  if (fs.existsSync(cleanroomDir)) {
    try {
      var entries2 = fs.readdirSync(cleanroomDir);
      for (var j = 0; j < entries2.length; j++) {
        if (entries2[j].endsWith('-universal.jar')) return path.join(cleanroomDir, entries2[j]);
        if (entries2[j].endsWith('.jar') && entries2[j].indexOf('installer') === -1) return path.join(cleanroomDir, entries2[j]);
      }
    } catch (e) {}
  }

  return null;
}

/**
 * Check if CleanRoom is installed (installer has been run).
 * The installer creates a version profile JSON in versions/cleanroom-X.Y.Z/
 */
function isCleanRoomInstalled(manifest) {
  if (!manifest || !manifest.cleanroom) return false;
  var version = manifest.cleanroom;

  // Check if the installer has run: look for the version JSON
  var versionJson = path.join(GAME_DIR, 'versions', 'cleanroom-' + version, 'cleanroom-' + version + '.json');
  if (fs.existsSync(versionJson)) return true;

  // Fallback: check if universal jar exists in cleanroom/ with libraries/
  var cleanroomDir = path.join(GAME_DIR, 'cleanroom');
  var libDir = path.join(cleanroomDir, 'libraries');
  if (fs.existsSync(libDir)) {
    try {
      var libEntries = fs.readdirSync(libDir);
      if (libEntries.length > 0) return true;
    } catch (e) {}
  }

  return false;
}

/**
 * Download and install CleanRoom modloader via the installer jar.
 * 1. Download installer jar from manifest URL
 * 2. Run: java -jar installer.jar --installClient GAME_DIR
 * 3. Installer downloads universal jar + all libraries + creates version profile
 */
async function installCleanRoom(manifest, webContents, javaPath) {
  if (!manifest || !manifest.cleanroomUrl) {
    console.log('[EriniumFaction] Pas d\'URL CleanRoom dans le manifeste, skip');
    return;
  }

  var cleanroomDir = path.join(GAME_DIR, 'cleanroom');
  ensureDir(cleanroomDir);

  // Download the installer jar
  var installerFileName = manifest.cleanroomUrl.split('/').pop();
  var installerPath = path.join(cleanroomDir, installerFileName);

  sendProgress(webContents, 'Telechargement de CleanRoom...', 0, manifest.cleanroom);

  await downloadGameFile(manifest.cleanroomUrl, installerPath, manifest.cleanroomSha256, function (progress) {
    sendProgress(webContents, 'Telechargement de CleanRoom...', progress.percent, formatBytes(progress.downloaded) + ' / ' + formatBytes(progress.total));
  });

  // Find Java to run the installer
  var javaExe = javaPath;
  if (!javaExe) {
    var detected = await autoDetectJava();
    if (detected.found) javaExe = detected.path;
  }
  if (!javaExe) {
    throw new Error('Java est requis pour installer CleanRoom. Configurez le chemin Java dans les parametres.');
  }
  // Use java.exe not javaw.exe for console output
  javaExe = javaExe.replace('javaw.exe', 'java.exe').replace('javaw', 'java');

  // Delete old CleanRoom version folders before installing new one
  var versionsDir = path.join(GAME_DIR, 'versions');
  if (fs.existsSync(versionsDir)) {
    try {
      var versionEntries = fs.readdirSync(versionsDir);
      for (var vi = 0; vi < versionEntries.length; vi++) {
        if (versionEntries[vi].startsWith('cleanroom-') && versionEntries[vi] !== 'cleanroom-' + manifest.cleanroom) {
          var oldDir = path.join(versionsDir, versionEntries[vi]);
          console.log('[EriniumFaction] Deleting old CleanRoom version: ' + versionEntries[vi]);
          fs.rmSync(oldDir, { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.warn('[EriniumFaction] Failed to clean old CleanRoom versions:', e.message);
    }
  }

  // The installer expects a launcher_profiles.json (like the Mojang launcher creates)
  var profilesPath = path.join(GAME_DIR, 'launcher_profiles.json');
  if (!fs.existsSync(profilesPath)) {
    fs.writeFileSync(profilesPath, JSON.stringify({ profiles: {} }, null, 2), 'utf-8');
  }

  // Run the installer: java -jar installer.jar --installClient GAME_DIR
  sendProgress(webContents, 'Installation de CleanRoom...', 50, 'Execution de l\'installateur...');
  console.log('[EriniumFaction] Running CleanRoom installer: ' + javaExe + ' -jar ' + installerPath + ' --installClient ' + GAME_DIR);

  await new Promise(function (resolve, reject) {
    var proc = spawn(javaExe, ['-jar', installerPath, '--installClient', GAME_DIR], {
      cwd: GAME_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    var stdout = '';
    var stderr = '';

    proc.stdout.on('data', function (data) {
      var line = data.toString().trim();
      stdout += line + '\n';
      if (line) {
        console.log('[CleanRoom-Installer] ' + line);
        sendProgress(webContents, 'Installation de CleanRoom...', 60, line.substring(0, 80));
      }
    });

    proc.stderr.on('data', function (data) {
      var line = data.toString().trim();
      stderr += line + '\n';
      if (line) console.error('[CleanRoom-Installer-ERR] ' + line);
    });

    proc.on('close', function (code) {
      if (code === 0) {
        console.log('[EriniumFaction] CleanRoom installer termine avec succes');
        resolve();
      } else {
        console.error('[EriniumFaction] CleanRoom installer echoue (code ' + code + ')');
        console.error('[EriniumFaction] stdout:', stdout);
        console.error('[EriniumFaction] stderr:', stderr);
        reject(new Error('CleanRoom installer echoue (code ' + code + '). Verifiez les logs.'));
      }
    });

    proc.on('error', function (err) {
      reject(new Error('Impossible de lancer l\'installateur CleanRoom: ' + err.message));
    });
  });

  sendProgress(webContents, 'CleanRoom installe !', 80, manifest.cleanroom);
  console.log('[EriniumFaction] CleanRoom installe: ' + manifest.cleanroom);
}

/**
 * Main game check and download flow.
 * Called when JOUER is clicked.
 */
async function checkAndDownloadGame(webContents) {
  var settings = store.get('settings', {});
  var gameDir = settings.gameDir || GAME_DIR;

  // Clean up any leftover .tmp files from previous interrupted downloads
  cleanupTmpFiles();

  // Ensure game directories exist
  ensureDir(gameDir);
  ensureDir(path.join(gameDir, 'mods'));
  ensureDir(path.join(gameDir, 'config'));
  ensureDir(path.join(gameDir, 'resourcepacks'));
  ensureDir(path.join(gameDir, 'logs'));

  // --- Step 1: Download MC vanilla ---
  sendStatus(webContents, 'checking', 'Verification de Minecraft...');
  sendProgress(webContents, 'Verification de Minecraft...', 0, '');

  try {
    var mcData = await downloadMinecraftVanilla(webContents, settings);
    console.log('[EriniumFaction] Minecraft vanilla OK');
  } catch (err) {
    console.error('[EriniumFaction] Erreur MC vanilla:', err.message);
    // If MC files already exist locally, continue anyway
    var versionJsonPath = path.join(MC_DIR, 'versions', MC_VERSION, MC_VERSION + '.json');
    if (!fs.existsSync(versionJsonPath)) {
      throw new Error('Impossible de telecharger Minecraft 1.12.2: ' + err.message);
    }
    console.log('[EriniumFaction] Fichiers MC locaux existants, on continue');
  }

  // --- Step 2: Fetch remote manifest ---
  sendStatus(webContents, 'checking', 'Verification des fichiers...');
  sendProgress(webContents, 'Verification des fichiers...', 10, 'Recuperation du manifeste...');

  var remoteManifest = await fetchRemoteManifest();
  var localManifest = loadLocalManifest();

  if (remoteManifest) {
    console.log('[EriniumFaction] Remote manifest: v' + remoteManifest.version + ', ' + (remoteManifest.files ? remoteManifest.files.length : 0) + ' files');
  } else {
    console.warn('[EriniumFaction] Remote manifest is NULL — offline mode');
  }
  if (localManifest) {
    console.log('[EriniumFaction] Local manifest: v' + localManifest.version + ', ' + (localManifest.files ? localManifest.files.length : 0) + ' files');
  } else {
    console.log('[EriniumFaction] No local manifest');
  }

  // --- Step 3: CleanRoom ---
  if (remoteManifest && remoteManifest.cleanroom) {
    sendProgress(webContents, 'Verification de CleanRoom...', 20, '');

    var javaPath = settings.javaPath || null;
    if (!javaPath && mcData && mcData.minecraftJava) {
      javaPath = mcData.minecraftJava.path;
    }

    if (!isCleanRoomInstalled(remoteManifest)) {
      sendStatus(webContents, 'downloading', 'Installation de CleanRoom...');
      try {
        await installCleanRoom(remoteManifest, webContents, javaPath);
      } catch (err) {
        console.error('[EriniumFaction] Erreur installation CleanRoom:', err.message);
        // If CleanRoom files exist locally, continue
        if (!isCleanRoomInstalled(localManifest || remoteManifest)) {
          throw new Error('Impossible d\'installer CleanRoom: ' + err.message);
        }
      }
    } else {
      console.log('[EriniumFaction] CleanRoom deja installe');
    }
  }

  // --- Step 4: Compare manifests and download changed files ---
  var effectiveManifest = remoteManifest || localManifest;

  if (!effectiveManifest) {
    // No manifest available at all — first launch offline
    console.warn('[EriniumFaction] Aucun manifeste disponible');
    sendProgress(webContents, 'Aucune mise a jour disponible', 100, 'Mode hors ligne');
  } else {
    // Filter out cleanroom/lib files since they were handled above
    var manifestForComparison = Object.assign({}, effectiveManifest);
    if (manifestForComparison.files) {
      manifestForComparison.files = manifestForComparison.files.filter(function (f) {
        return f.category !== 'cleanroom' && f.category !== 'lib';
      });
    }
    var localForComparison = localManifest ? Object.assign({}, localManifest) : null;
    if (localForComparison && localForComparison.files) {
      localForComparison.files = localForComparison.files.filter(function (f) {
        return f.category !== 'cleanroom' && f.category !== 'lib';
      });
    }

    var comparison = await compareManifests(manifestForComparison, localForComparison);

    // Delete files that were removed from the manifest
    if (comparison.toDelete.length > 0) {
      deleteRemovedFiles(comparison.toDelete);
    }

    // Download new/changed files
    if (comparison.toDownload.length > 0) {
      sendStatus(webContents, 'downloading', 'Telechargement des fichiers...');
      sendProgress(webContents, 'Telechargement...', 30, comparison.toDownload.length + ' fichier(s) a telecharger');

      await downloadManifestFiles(comparison.toDownload, webContents);
    } else {
      console.log('[EriniumFaction] Tous les fichiers sont a jour');
    }

    // Save manifest
    if (remoteManifest) {
      saveLocalManifest(remoteManifest);
    }
  }

  // --- Step 5: Verify critical files ---
  sendProgress(webContents, 'Verification de l\'integrite...', 90, '');
  if (effectiveManifest && effectiveManifest.files) {
    var criticalFiles = effectiveManifest.files.filter(function (f) { return f.critical; });
    for (var i = 0; i < criticalFiles.length; i++) {
      var filePath = path.join(GAME_DIR, criticalFiles[i].path);
      var valid = await verifyFile(filePath, criticalFiles[i].sha256);
      if (!valid) {
        console.warn('[EriniumFaction] Fichier critique invalide, re-telechargement: ' + criticalFiles[i].path);
        await downloadGameFile(criticalFiles[i].url, filePath, criticalFiles[i].sha256, null);
      }
    }
  }

  // --- Step 6: Whitelist check for mods/ ---
  sendProgress(webContents, 'Verification des mods...', 95, '');
  var movedMods = enforceModsWhitelist(effectiveManifest, gameDir);
  if (movedMods.length > 0) {
    sendProgress(webContents, 'Mods non autorises deplaces', 95, movedMods.length + ' mod(s) deplace(s) dans mods_disabled/');
  }

  // --- Step 7: Optional mods sync ---
  sendProgress(webContents, 'Mods optionnels...', 97, '');
  await syncOptionalMods(effectiveManifest, settings);

  // --- Done ---
  sendProgress(webContents, 'Pret !', 100, '');
  sendStatus(webContents, 'launching', 'Lancement du jeu...');

  // Determine java path — CleanRoom requires Java 25+
  var finalJavaPath = settings.javaPath || null;
  var detectedJavaMajor = 0;

  if (finalJavaPath) {
    // User-configured path: verify it's Java 25+
    var userVersion = await getJavaVersion(finalJavaPath);
    detectedJavaMajor = getMajorVersion(userVersion);
    if (detectedJavaMajor < 25) {
      console.log('[EriniumFaction] Configured Java is v' + detectedJavaMajor + ', need 25+. Ignoring.');
      finalJavaPath = null;
    }
  }

  if (!finalJavaPath) {
    // Try auto-detect — prefers Java 25+
    var detected = await autoDetectJava();
    if (detected.found) {
      detectedJavaMajor = getMajorVersion(detected.version);
      if (detectedJavaMajor >= 25) {
        finalJavaPath = detected.path;
      }
    }
  }

  // No Java 25+ found — auto-download
  if (!finalJavaPath) {
    console.log('[EriniumFaction] No Java 25+ found. Downloading automatically...');
    sendProgress(webContents, 'Installation de Java 25...', 95, 'CleanRoom necessite Java 25');
    sendStatus(webContents, 'downloading', 'Installation de Java 25...');
    try {
      var javaResult = await downloadAndInstallJava(webContents);
      finalJavaPath = javaResult.path;
      console.log('[EriniumFaction] Java 25 installed at: ' + finalJavaPath);
    } catch (err) {
      console.error('[EriniumFaction] Failed to install Java 25: ' + err.message);
      sendStatus(webContents, 'error', 'Impossible d\'installer Java 25 : ' + err.message);
      throw new Error('Java 25 est requis pour CleanRoom. Installation automatique echouee: ' + err.message);
    }
  }

  return {
    ready: true,
    javaPath: finalJavaPath,
    gameDir: gameDir,
    mcData: mcData || null,
    manifest: effectiveManifest,
  };
}

/**
 * Recursively walk a directory and collect all .jar files.
 */
function walkJars(dir) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fullPath = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) {
        results = results.concat(walkJars(fullPath));
      } else if (entries[i].name.endsWith('.jar')) {
        results.push(fullPath);
      }
    }
  } catch (e) {}
  return results;
}

/**
 * Read the CleanRoom version profile JSON (created by the installer).
 * Returns { mainClass, libraries: [...paths], inheritsFrom, ... } or null.
 */
function readCleanRoomProfile(gameDir, manifest) {
  var version = (manifest && manifest.cleanroom) || '0.5.7-alpha';
  var profileId = 'cleanroom-' + version;
  var profilePath = path.join(gameDir, 'versions', profileId, profileId + '.json');

  if (!fs.existsSync(profilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  } catch (e) {
    console.error('[EriniumFaction] Erreur lecture profil CleanRoom:', e.message);
    return null;
  }
}

/**
 * Build the classpath for launching with CleanRoom.
 * Reads the CleanRoom version profile to get its libraries,
 * then adds MC vanilla libraries and our mods.
 */
function buildClasspath(mcDir, gameDir, manifest) {
  var classpath = [];
  var added = {};

  function addJar(p) {
    if (!added[p] && fs.existsSync(p)) {
      classpath.push(p);
      added[p] = true;
    }
  }

  // --- CleanRoom profile libraries (installed by the installer) ---
  var profile = readCleanRoomProfile(gameDir, manifest);
  if (profile && profile.libraries) {
    for (var i = 0; i < profile.libraries.length; i++) {
      var lib = profile.libraries[i];
      // Standard Forge/CleanRoom format: downloads.artifact.path
      if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
        addJar(path.join(gameDir, 'libraries', lib.downloads.artifact.path));
      }
      // Maven name format: group:artifact:version -> group/artifact/version/artifact-version.jar
      else if (lib.name) {
        var parts = lib.name.split(':');
        if (parts.length >= 3) {
          var mavenPath = parts[0].replace(/\./g, '/') + '/' + parts[1] + '/' + parts[2] + '/' + parts[1] + '-' + parts[2] + '.jar';
          addJar(path.join(gameDir, 'libraries', mavenPath));
        }
      }
    }
  }

  // --- CleanRoom universal jar ---
  var cleanroomJar = getCleanRoomJarPath(manifest);
  if (cleanroomJar) addJar(cleanroomJar);

  // --- Fallback: walk cleanroom/libraries/ if installer didn't create a profile ---
  if (!profile) {
    var cleanroomLibDir = path.join(gameDir, 'cleanroom', 'libraries');
    var fallbackJars = walkJars(cleanroomLibDir);
    for (var fi = 0; fi < fallbackJars.length; fi++) addJar(fallbackJars[fi]);
  }

  // --- MC vanilla client jar ---
  addJar(path.join(mcDir, 'versions', MC_VERSION, MC_VERSION + '.jar'));

  // --- MC vanilla libraries (skip libs that CleanRoom replaces) ---
  // CleanRoom replaces LWJGL 2, guava, gson, commons, netty, etc. with modern versions.
  // If CleanRoom profile exists, skip vanilla libs that conflict.
  var skipPrefixes = [];
  if (profile) {
    // These vanilla libs are replaced by CleanRoom's own versions
    skipPrefixes = [
      'org/lwjgl/',           // LWJGL 2 replaced by LWJGL 3
      'net/java/jinput/',     // Old jinput replaced
      'net/java/jutils/',     // Old jutils
    ];
  }

  var mcVersionJsonPath = path.join(mcDir, 'versions', MC_VERSION, MC_VERSION + '.json');
  if (fs.existsSync(mcVersionJsonPath)) {
    try {
      var mcVersionJson = JSON.parse(fs.readFileSync(mcVersionJsonPath, 'utf-8'));
      if (mcVersionJson.libraries) {
        for (var j = 0; j < mcVersionJson.libraries.length; j++) {
          var mcLib = mcVersionJson.libraries[j];
          if (mcLib.downloads && mcLib.downloads.artifact && mcLib.downloads.artifact.path) {
            var libArtifactPath = mcLib.downloads.artifact.path;
            // Skip libs that CleanRoom replaces
            var skip = false;
            for (var sp = 0; sp < skipPrefixes.length; sp++) {
              if (libArtifactPath.startsWith(skipPrefixes[sp])) {
                skip = true;
                break;
              }
            }
            if (!skip) {
              addJar(path.join(mcDir, 'libraries', libArtifactPath));
            }
          }
        }
      }
    } catch (e) {
      console.error('[EriniumFaction] Erreur lecture MC version JSON:', e.message);
    }
  }

  return classpath;
}

/**
 * Launch the game as a child process.
 */
function launchGame(javaPath, token, settings, webContents, manifest) {
  return new Promise(function (resolve, reject) {
    var gameDir = (settings && settings.gameDir) || GAME_DIR;
    var ramMax = (settings && settings.ram) ? settings.ram : 4;
    var ramMin = Math.max(1, Math.floor(ramMax / 2));
    var jvmArgs = (settings && settings.jvmArgs) ? settings.jvmArgs.trim().split(/\s+/).filter(function (a) { return a; }) : [];

    // Build classpath
    var classpath = buildClasspath(MC_DIR, gameDir, manifest);
    var cpSeparator = process.platform === 'win32' ? ';' : ':';
    var cpString = classpath.join(cpSeparator);

    // Determine natives directory (only for vanilla MC without CleanRoom)
    var nativesDir = path.join(MC_DIR, 'versions', MC_VERSION, 'natives');
    if (!fs.existsSync(nativesDir)) {
      nativesDir = path.join(MC_DIR, 'natives');
    }

    // Determine assets directory and index
    var assetsDir = path.join(MC_DIR, 'assets');
    var assetsIndex = MC_VERSION;

    // Read CleanRoom profile for mainClass and tweakClass
    var crProfile = readCleanRoomProfile(gameDir, manifest);
    var hasCleanRoom = !!crProfile;
    var mainClass = (crProfile && crProfile.mainClass) || 'com.cleanroommc.boot.MainClient';
    var tweakClass = null;

    // CleanRoom profile may specify a tweakClass in minecraftArguments
    if (crProfile && crProfile.minecraftArguments) {
      var tweakMatch = crProfile.minecraftArguments.match(/--tweakClass\s+(\S+)/);
      if (tweakMatch) tweakClass = tweakMatch[1];
    }

    // Read vanilla version JSON for assets index
    var versionJsonPath = path.join(MC_DIR, 'versions', MC_VERSION, MC_VERSION + '.json');
    if (fs.existsSync(versionJsonPath)) {
      try {
        var vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
        if (vj.assets) assetsIndex = vj.assets;
      } catch (e) {}
    }

    // Get user info
    var user = getUser() || {};
    var playerName = user.mcName || 'Player';
    var uuid = user.discordId || '00000000-0000-0000-0000-000000000000';

    // Build arguments
    var args = [];

    // JVM args
    args.push('-Xms' + ramMin + 'G');
    args.push('-Xmx' + ramMax + 'G');
    // CleanRoom/LWJGL3 extracts natives from jars automatically — skip old natives path
    if (!hasCleanRoom) {
      args.push('-Djava.library.path=' + nativesDir);
    }
    args.push('-Dminecraft.applet.TargetDirectory=' + gameDir);

    // Auth token as JVM arg (must be before -cp so it's in JVM args, not game args)
    if (token) {
      args.push('-Detk=' + token);
    }

    // Custom JVM args from settings
    if (jvmArgs.length > 0) {
      args = args.concat(jvmArgs);
    }

    // Classpath
    args.push('-cp');
    args.push(cpString);

    // Main class from CleanRoom profile
    args.push(mainClass);

    // Game args
    args.push('--username');
    args.push(playerName);
    args.push('--version');
    args.push(MC_VERSION);
    args.push('--gameDir');
    args.push(gameDir);
    args.push('--assetsDir');
    args.push(assetsDir);
    args.push('--assetIndex');
    args.push(assetsIndex);
    args.push('--uuid');
    args.push(uuid);
    args.push('--accessToken');
    args.push(token || 'offline');

    // CleanRoom tweaker (from profile or default Forge tweaker)
    if (tweakClass) {
      args.push('--tweakClass');
      args.push(tweakClass);
    }

    console.log('[EriniumFaction] Lancement avec Java: ' + javaPath);
    console.log('[EriniumFaction] Game dir: ' + gameDir);
    console.log('[EriniumFaction] RAM: ' + ramMin + 'G - ' + ramMax + 'G');

    gameProcess = spawn(javaPath, args, {
      cwd: gameDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    gameProcess.stdout.on('data', function (data) {
      var line = data.toString('utf-8').trim();
      if (line) console.log('[MC] ' + line);
    });

    gameProcess.stderr.on('data', function (data) {
      var line = data.toString('utf-8').trim();
      if (line) console.error('[MC-ERR] ' + line);
    });

    gameProcess.on('close', function (code) {
      console.log('[EriniumFaction] Minecraft ferme avec code: ' + code);
      gameProcess = null;
      sendStatus(webContents, 'closed', 'Jeu ferme (code ' + code + ')');
    });

    gameProcess.on('error', function (err) {
      console.error('[EriniumFaction] Erreur lancement Java:', err.message);
      gameProcess = null;
      reject(err);
      return;
    });

    // Unref so the launcher doesn't keep the game alive if we close
    gameProcess.unref();

    // Consider launched after a short delay (give Java time to fail if it will)
    setTimeout(function () {
      if (gameProcess) {
        sendStatus(webContents, 'playing', 'En jeu');

        // Handle close-on-launch setting
        if (settings && settings.closeOnLaunch) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.hide();
          }
        }

        resolve();
      }
    }, 2000);
  });
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  // Auth
  ipcMain.handle('auth:start-discord', async () => {
    try {
      const port = await startOAuthCallbackServer();
      const redirectUri = encodeURIComponent('http://localhost:' + port + '/callback');
      const authUrl = SITE_URL + '/api/auth/discord?source=launcher&port=' + port +
        '&redirect_uri=' + redirectUri + '&state=' + oauthState;
      shell.openExternal(authUrl);
      return { success: true, port: port };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('auth:dev-login', async () => {
    const user = devLogin();
    return { success: true, user: user };
  });

  ipcMain.handle('auth:get-session', async () => {
    const jwt = getToken('jwt');
    if (!jwt) return { valid: false };
    const user = getUser();
    if (!user) return { valid: false };
    // Check expiration
    if (user.exp && user.exp * 1000 < Date.now()) {
      // Token expired — try refresh
      clearTokens();
      return { valid: false };
    }
    return { valid: true, user: user };
  });

  ipcMain.handle('auth:logout', async () => {
    clearTokens();
    return { success: true };
  });

  // Fetch the up-to-date launcher profile (MC name + rank prefix) from the site.
  // Returns null if the user is not authenticated or the site is unreachable.
  ipcMain.handle('auth:get-profile', async () => {
    const jwt = getToken('jwt');
    if (!jwt) return null;
    const data = await fetchJSON(SITE_URL + '/api/launcher/profile', {
      'Authorization': 'Bearer ' + jwt,
      'Accept': 'application/json',
    });
    return data;
  });

  // App
  ipcMain.handle('app:get-version', async () => {
    return APP_VERSION;
  });

  ipcMain.handle('app:is-dev', async () => {
    return !IS_PRODUCTION;
  });

  ipcMain.handle('app:open-logs', async () => {
    shell.openPath(LOG_DIR);
    return { success: true };
  });

  ipcMain.handle('app:quit', async () => {
    // On main screen: hide to tray. On login/splash: actually quit.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
  });

  ipcMain.handle('app:minimize', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.minimize();
  });

  ipcMain.handle('app:maximize', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  // Server status
  ipcMain.handle('server:get-status', async () => {
    const data = await fetchJSON(SITE_URL + '/api/server/status');
    if (data) return data;
    return { online: false, players: 0, maxPlayers: 1000, tps: 0 };
  });

  // News
  ipcMain.handle('news:get-latest', async () => {
    const data = await fetchJSON(SITE_URL + '/api/news');
    if (data && Array.isArray(data)) return data.slice(0, 5);
    if (data && data.articles) return data.articles.slice(0, 5);
    return [];
  });

  // Game launch — full download, verify, launch flow
  ipcMain.handle('game:launch', async (event) => {
    var sender = event.sender;
    console.log('[EriniumFaction] Game launch requested');

    // Check if already playing
    if (gameProcess) {
      return { success: false, error: 'Le jeu est deja en cours d\'execution' };
    }

    try {
      var result = await checkAndDownloadGame(sender);
      if (!result.ready) {
        return { success: false, error: result.error || 'Preparation echouee' };
      }

      // Get auth token
      var token = getToken('jwt');
      var settings = store.get('settings', {});
      var javaPath = settings.javaPath || result.javaPath;

      if (!javaPath) {
        return { success: false, error: 'Java non trouve. Configurez le chemin Java dans les parametres.' };
      }

      await launchGame(javaPath, token, settings, sender, result.manifest);
      return { success: true };
    } catch (err) {
      console.error('[EriniumFaction] Erreur game:launch:', err.message);
      sendStatus(sender, 'error', err.message);
      return { success: false, error: err.message };
    }
  });

  // Fetch manifest (for optional mods panel)
  ipcMain.handle('game:fetch-manifest', async () => {
    try {
      return await fetchRemoteManifest();
    } catch (err) {
      console.error('[EriniumFaction] Fetch manifest error:', err.message);
      return null;
    }
  });

  // Game repair — force re-verify all files
  ipcMain.handle('game:repair', async (event) => {
    var sender = event.sender;
    console.log('[EriniumFaction] Game repair requested');

    try {
      // Delete local manifest to force full re-check
      var manifestPath = path.join(GAME_DIR, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }
      sendStatus(sender, 'checking', 'Reparation en cours...');
      var result = await checkAndDownloadGame(sender);
      sendStatus(sender, 'checking', 'Reparation terminee');
      return { success: true };
    } catch (err) {
      console.error('[EriniumFaction] Erreur game:repair:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Settings
  ipcMain.handle('settings:get', async () => {
    return store.get('settings', {
      ram: 4,
      javaPath: '',
      gameDir: path.join(app.getPath('appData'), '.eriniumfaction'),
      jvmArgs: '',
      closeOnLaunch: false,
      startWithWindows: false,
      notifications: true,
      language: 'fr',
    });
  });

  ipcMain.handle('settings:save', async (event, settings) => {
    store.set('settings', settings);
    return { success: true };
  });

  // Java detection & download
  ipcMain.handle('settings:detect-java', async () => {
    try {
      return await autoDetectJava();
    } catch (e) {
      return { found: false, path: '', version: '', error: e.message };
    }
  });

  ipcMain.handle('settings:browse-java', async () => {
    var filters = process.platform === 'win32'
      ? [{ name: 'Java', extensions: ['exe'] }]
      : [{ name: 'All Files', extensions: ['*'] }];
    var result = await dialog.showOpenDialog({
      title: process.platform === 'win32' ? 'Selectionner javaw.exe' : 'Selectionner le binaire java',
      filters: filters,
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }
    var selectedPath = result.filePaths[0];
    var version = await getJavaVersion(selectedPath);
    return { canceled: false, path: selectedPath, version: version || '' };
  });

  ipcMain.handle('settings:browse-dir', async () => {
    var result = await dialog.showOpenDialog({
      title: 'Selectionner le repertoire du jeu',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('java:check', async () => {
    // Check saved settings first
    var settings = store.get('settings', {});
    if (settings.javaPath) {
      var version = await getJavaVersion(settings.javaPath);
      if (version) {
        return { found: true, path: settings.javaPath, version: version };
      }
    }
    // Fall back to auto-detection
    return await autoDetectJava();
  });

  ipcMain.handle('java:download', async (event) => {
    try {
      var result = await downloadAndInstallJava(event.sender);
      return { success: true, path: result.path, version: result.version };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // HWID
  ipcMain.handle('hwid:get', async () => {
    return collectHWID();
  });

  // Window controls for frameless windows
  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  // Navigate to main window after dev login
  ipcMain.handle('nav:go-main', async () => {
    createMainWindow();
    return { success: true };
  });

  // Navigate back to login
  ipcMain.handle('nav:go-login', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
      mainWindow = null;
    }
    createLoginWindow();
    return { success: true };
  });

  // Open external link
  ipcMain.handle('shell:open-external', async (event, url) => {
    shell.openExternal(url);
    return { success: true };
  });

  // Auto-updater actions
  ipcMain.handle('update:check', async () => {
    if (!IS_PRODUCTION) {
      // In dev mode, auto-updater doesn't work — fake "no update"
      console.log('[AutoUpdater] Mode dev, skip check');
      broadcastUpdaterEvent('update:not-available');
      return { success: true, version: null };
    }
    try {
      var result = await autoUpdater.checkForUpdates();
      return { success: true, version: result ? result.updateInfo.version : null };
    } catch (err) {
      broadcastUpdaterEvent('update:error', { message: err.message });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('update:install', async () => {
    if (!IS_PRODUCTION) return { success: false, error: 'Dev mode' };
    isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  registerIpcHandlers();
  createTray();
  createSplashWindow();

  // -------------------------------------------------------------------------
  // Anti-tamper: block DevTools shortcuts and context menu in production
  // -------------------------------------------------------------------------
  if (IS_PRODUCTION) {
    // Block common DevTools shortcuts globally
    app.on('browser-window-created', function (_event, win) {
      win.webContents.on('before-input-event', function (_e, input) {
        // Block F12
        if (input.key === 'F12') { _e.preventDefault(); }
        // Block Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
        if (input.control && input.shift && (input.key === 'I' || input.key === 'J' || input.key === 'C')) {
          _e.preventDefault();
        }
        // Block Ctrl+U (view source)
        if (input.control && input.key === 'U') { _e.preventDefault(); }
      });

      // Disable context menu in production
      win.webContents.on('context-menu', function (e) {
        e.preventDefault();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Auto-updater (electron-updater)
  // -------------------------------------------------------------------------
  if (IS_PRODUCTION) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = {
      info: function (msg) { console.log('[AutoUpdater] ' + msg); },
      warn: function (msg) { console.warn('[AutoUpdater] ' + msg); },
      error: function (msg) { console.error('[AutoUpdater] ' + msg); },
      debug: function (msg) { console.log('[AutoUpdater-DBG] ' + msg); },
    };

    autoUpdater.on('checking-for-update', function () {
      console.log('[AutoUpdater] Verification des mises a jour...');
      broadcastUpdaterEvent('update:checking');
    });

    autoUpdater.on('update-available', function (info) {
      console.log('[AutoUpdater] Mise a jour disponible:', info.version);
      broadcastUpdaterEvent('update:available', {
        version: info.version,
        releaseDate: info.releaseDate || null,
      });
    });

    autoUpdater.on('update-not-available', function () {
      console.log('[AutoUpdater] Aucune mise a jour disponible');
      broadcastUpdaterEvent('update:not-available');
    });

    autoUpdater.on('download-progress', function (progress) {
      console.log('[AutoUpdater] Progress: ' + Math.round(progress.percent) + '%');
      broadcastUpdaterEvent('update:download-progress', {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    autoUpdater.on('update-downloaded', function (info) {
      console.log('[AutoUpdater] Mise a jour telechargee:', info.version);
      broadcastUpdaterEvent('update:downloaded', {
        version: info.version,
      });
    });

    autoUpdater.on('error', function (err) {
      console.error('[AutoUpdater] ERREUR:', err.message);
      console.error('[AutoUpdater] Stack:', err.stack || 'N/A');
      broadcastUpdaterEvent('update:error', { message: err.message });
    });
  }
});

/**
 * Broadcast an auto-updater event to all open windows via IPC.
 */
function broadcastUpdaterEvent(channel, data) {
  var allWindows = BrowserWindow.getAllWindows();
  for (var i = 0; i < allWindows.length; i++) {
    if (!allWindows[i].isDestroyed() && allWindows[i].webContents) {
      allWindows[i].webContents.send(channel, data || {});
    }
  }
}

// Don't quit when all windows closed — tray keeps the app alive
app.on('window-all-closed', () => {
  // Do nothing — the tray icon keeps the app running
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (mainWindow === null && loginWindow === null) {
      createSplashWindow();
    }
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

// ---------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------
function createTray() {
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      // Fallback: create a simple 16x16 purple icon
      trayIcon = nativeImage.createEmpty();
    }
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('EriniumFaction Launcher');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Ouvrir EriniumFaction',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        } else if (loginWindow && !loginWindow.isDestroyed()) {
          loginWindow.show();
          loginWindow.focus();
        } else {
          createSplashWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Fermer',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click tray icon → show window
  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
