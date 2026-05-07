const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  auth: {
    startDiscord: () => ipcRenderer.invoke('auth:start-discord'),
    devLogin: () => ipcRenderer.invoke('auth:dev-login'),
    getSession: () => ipcRenderer.invoke('auth:get-session'),
    getProfile: () => ipcRenderer.invoke('auth:get-profile'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    onToken: (cb) => ipcRenderer.on('auth:token-received', (_e, data) => cb(data)),
    onError: (cb) => ipcRenderer.on('auth:error', (_e, data) => cb(data)),
  },
  server: {
    getStatus: () => ipcRenderer.invoke('server:get-status'),
  },
  news: {
    getLatest: () => ipcRenderer.invoke('news:get-latest'),
  },
  game: {
    launch: () => ipcRenderer.invoke('game:launch'),
    repair: () => ipcRenderer.invoke('game:repair'),
    fetchManifest: () => ipcRenderer.invoke('game:fetch-manifest'),
    onProgress: (cb) => ipcRenderer.on('game:progress', function (_e, data) { cb(data); }),
    onStatus: (cb) => ipcRenderer.on('game:status', function (_e, data) { cb(data); }),
    removeProgressListeners: () => ipcRenderer.removeAllListeners('game:progress'),
    removeStatusListeners: () => ipcRenderer.removeAllListeners('game:status'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    detectJava: () => ipcRenderer.invoke('settings:detect-java'),
    browseJava: () => ipcRenderer.invoke('settings:browse-java'),
    browseDir: () => ipcRenderer.invoke('settings:browse-dir'),
  },
  java: {
    check: () => ipcRenderer.invoke('java:check'),
    download: () => ipcRenderer.invoke('java:download'),
    onProgress: (callback) => ipcRenderer.on('java:download-progress', (_, data) => callback(data)),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    isDev: () => ipcRenderer.invoke('app:is-dev'),
    openLogs: () => ipcRenderer.invoke('app:open-logs'),
    quit: () => ipcRenderer.invoke('app:quit'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    maximize: () => ipcRenderer.invoke('app:maximize'),
  },
  nav: {
    goMain: () => ipcRenderer.invoke('nav:go-main'),
    goLogin: () => ipcRenderer.invoke('nav:go-login'),
  },
  hwid: {
    get: () => ipcRenderer.invoke('hwid:get'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onChecking: (cb) => ipcRenderer.on('update:checking', (_e) => cb()),
    onAvailable: (cb) => ipcRenderer.on('update:available', (_e, data) => cb(data)),
    onNotAvailable: (cb) => ipcRenderer.on('update:not-available', (_e) => cb()),
    onDownloadProgress: (cb) => ipcRenderer.on('update:download-progress', (_e, data) => cb(data)),
    onDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, data) => cb(data)),
    onError: (cb) => ipcRenderer.on('update:error', (_e, data) => cb(data)),
  },
});
