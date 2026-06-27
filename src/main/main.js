// ============================================================
// Main Screen — Skyzer Launcher
// ============================================================

(function () {
  // ---- DOM références ----
  var btnMinimize = document.getElementById('btnMinimize');
  var btnMaximize = document.getElementById('btnMaximize');
  var btnClose = document.getElementById('btnClose');
  var btnSettings = document.getElementById('btnSettings');
  var btnLogout = document.getElementById('btnLogout');
  var btnPlay = document.getElementById('btnPlay');
  var playText = document.getElementById('playText');
  var playIcon = document.getElementById('playIcon');
  var linkLogs = document.getElementById('linkLogs');

  var playerAvatar = document.getElementById('playerAvatar');
  var playerName = document.getElementById('playerName');

  var settingsOverlay = document.getElementById('settingsOverlay');
  var settingsBackdrop = document.getElementById('settingsBackdrop');
  var btnCloseSettings = document.getElementById('btnCloseSettings');
  var btnSaveSettings = document.getElementById('btnSaveSettings');
  var settingRam = document.getElementById('settingRam');
  var settingRamValue = document.getElementById('settingRamValue');
  var settingJavaPath = document.getElementById('settingJavaPath');
  var settingGameDir = document.getElementById('settingGameDir');
  var settingJvmArgs = document.getElementById('settingJvmArgs');
  var settingCloseOnLaunch = document.getElementById('settingCloseOnLaunch');
  var settingNotifications = document.getElementById('settingNotifications');

  var btnDetectJava = document.getElementById('btnDetectJava');
  var btnBrowseJava = document.getElementById('btnBrowseJava');
  var btnBrowseDir = document.getElementById('btnBrowseDir');
  var javaVersionInfo = document.getElementById('javaVersionInfo');
  var javaVersionBadge = document.getElementById('javaVersionBadge');
  var javaWarningBanner = document.getElementById('javaWarningBanner');
  var btnDownloadJava = document.getElementById('btnDownloadJava');
  var javaDownloadProgress = document.getElementById('javaDownloadProgress');
  var javaDlLabel = document.getElementById('javaDlLabel');
  var javaDlPercent = document.getElementById('javaDlPercent');
  var javaDlBarFill = document.getElementById('javaDlBarFill');

  var modsOverlay = document.getElementById('modsOverlay');
  var modsBackdrop = document.getElementById('modsBackdrop');
  var btnOptionalMods = document.getElementById('btnOptionalMods');
  var btnCloseMods = document.getElementById('btnCloseMods');
  var btnSaveMods = document.getElementById('btnSaveMods');
  var modsListContainer = document.getElementById('modsListContainer');

  var gameProgress = document.getElementById('gameProgress');
  var gameProgressLabel = document.getElementById('gameProgressLabel');
  var gameProgressPercent = document.getElementById('gameProgressPercent');
  var gameProgressFill = document.getElementById('gameProgressFill');
  var gameProgressDetail = document.getElementById('gameProgressDetail');

  var footerVersion = document.getElementById('footerVersion');

  // ---- State ----
  var isPlaying = false;
  var isDownloadingJava = false;
  var lastError = null;

  // ---- Init ----
  function init() {
    loadVersion();
    loadProfile();
    loadSettings();
  }

  function loadVersion() {
    window.launcher.app.getVersion().then(function (v) {
      footerVersion.textContent = v;
    });
  }

  function loadProfile() {
    window.launcher.auth.getSession().then(function (session) {
      if (session && session.valid && session.user) {
        var user = session.user;
        var name = user.name || 'Joueur';
        playerName.textContent = name;
        // Avatar depuis crafatar.com (skin Minecraft officiel)
        if (user.uuid) {
          var cleanUuid = user.uuid.replace(/-/g, '');
          playerAvatar.src = 'https://crafatar.com/avatars/' + cleanUuid + '?size=80&overlay';
        }
      }
    }).catch(function () {
      playerName.textContent = 'Joueur';
    });
  }

  // ---- Play button ----
  function setPlayButtonState(state, text) {
    btnPlay.className = 'btn btn-play';
    var existingSpinner = btnPlay.querySelector('.play-spinner');
    if (existingSpinner) existingSpinner.remove();

    switch (state) {
      case 'default':
        btnPlay.disabled = false;
        playIcon.textContent = '▶';
        playText.textContent = text || 'JOUER';
        break;
      case 'checking':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-checking');
        playIcon.textContent = '';
        addSpinner();
        playText.textContent = text || 'VÉRIFICATION...';
        break;
      case 'downloading':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-downloading');
        playIcon.textContent = '';
        addSpinner();
        playText.textContent = text || 'TÉLÉCHARGEMENT...';
        break;
      case 'installing':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-installing');
        playIcon.textContent = '';
        addSpinner();
        playText.textContent = text || 'INSTALLATION...';
        break;
      case 'launching':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-launching');
        playIcon.textContent = '';
        addSpinner();
        playText.textContent = text || 'LANCEMENT...';
        break;
      case 'playing':
        isPlaying = true;
        btnPlay.disabled = true;
        btnPlay.classList.add('state-playing');
        playIcon.textContent = '';
        playText.textContent = text || 'EN JEU';
        break;
      case 'error':
        isPlaying = false;
        btnPlay.disabled = false;
        btnPlay.classList.add('state-error');
        playIcon.textContent = '';
        playText.textContent = text || 'ERREUR — CLIQUER POUR RÉESSAYER';
        break;
    }
  }

  function addSpinner() {
    var s = document.createElement('div');
    s.className = 'play-spinner';
    btnPlay.insertBefore(s, playText);
  }

  function showProgress(step, percent, detail) {
    gameProgress.classList.remove('hidden');
    gameProgressLabel.textContent = step || '';
    gameProgressDetail.textContent = detail || '';
    if (percent < 0) {
      gameProgressFill.classList.add('indeterminate');
      gameProgressPercent.textContent = '';
    } else {
      gameProgressFill.classList.remove('indeterminate');
      gameProgressFill.style.width = Math.min(100, Math.max(0, percent)) + '%';
      gameProgressPercent.textContent = percent > 0 ? percent + '%' : '';
    }
  }

  function hideProgress() {
    gameProgress.classList.add('hidden');
    gameProgressFill.classList.remove('indeterminate');
    gameProgressFill.style.width = '0%';
    gameProgressPercent.textContent = '';
    gameProgressDetail.textContent = '';
  }

  function resetPlayButton() {
    isPlaying = false;
    lastError = null;
    hideProgress();
    setPlayButtonState('default', 'JOUER');
  }

  // ---- IPC events ----
  window.launcher.game.onProgress(function (data) {
    showProgress(data.step, data.percent, data.detail);
  });

  window.launcher.game.onStatus(function (data) {
    switch (data.status) {
      case 'checking':
        setPlayButtonState('checking', 'VÉRIFICATION...');
        break;
      case 'downloading':
        setPlayButtonState('downloading', 'TÉLÉCHARGEMENT...');
        break;
      case 'installing':
        setPlayButtonState('installing', 'INSTALLATION...');
        break;
      case 'launching':
        setPlayButtonState('launching', 'LANCEMENT...');
        break;
      case 'playing':
        setPlayButtonState('playing', 'EN JEU');
        setTimeout(hideProgress, 2000);
        break;
      case 'closed':
        resetPlayButton();
        break;
      case 'error':
        lastError = data.message;
        setPlayButtonState('error', 'ERREUR — CLIQUER POUR RÉESSAYER');
        showProgress('Erreur', 0, data.message || 'Une erreur est survenue');
        break;
    }
  });

  // ---- Play click ----
  btnPlay.addEventListener('click', function () {
    if (isPlaying) return;
    if (btnPlay.classList.contains('state-error')) lastError = null;

    window.launcher.java.check().then(function (javaResult) {
      if (!javaResult || !javaResult.found) {
        openSettings();
        showJavaWarning();
        return;
      }
      setPlayButtonState('checking', 'VÉRIFICATION...');
      showProgress('Démarrage...', 0, '');
      window.launcher.game.launch().then(function (result) {
        if (result && !result.success) {
          lastError = result.error || 'Erreur inconnue';
          setPlayButtonState('error', 'ERREUR — CLIQUER POUR RÉESSAYER');
          showProgress('Erreur', 0, lastError);
        }
      }).catch(function (err) {
        lastError = err.message || 'Erreur inconnue';
        setPlayButtonState('error', 'ERREUR — CLIQUER POUR RÉESSAYER');
        showProgress('Erreur', 0, lastError);
      });
    }).catch(function () {
      openSettings();
      showJavaWarning();
    });
  });

  // ---- Settings ----
  function loadSettings() {
    window.launcher.settings.get().then(function (s) {
      settingRam.value = s.ram || 4;
      settingRamValue.textContent = (s.ram || 4) + ' Go';
      settingJavaPath.value = s.javaPath || '';
      settingGameDir.value = s.gameDir || '';
      settingJvmArgs.value = s.jvmArgs || '';
      settingCloseOnLaunch.checked = !!s.closeOnLaunch;
      settingNotifications.checked = s.notifications !== false;
      if (!s.javaPath) detectJavaAndUpdateUI();
      else validateJavaPath(s.javaPath);
    });
  }

  function showJavaWarning() { javaWarningBanner.classList.remove('hidden'); }
  function hideJavaWarning() { javaWarningBanner.classList.add('hidden'); }

  function getMajorVersion(v) {
    if (!v) return 0;
    var parts = v.split(/[._-]/);
    var major = parseInt(parts[0], 10);
    if (major === 1 && parts.length > 1) return parseInt(parts[1], 10);
    return major;
  }

  function showJavaVersion(version, isValid) {
    javaVersionInfo.classList.remove('hidden');
    if (isValid) {
      javaVersionBadge.textContent = 'Java ' + version + ' détecté';
      javaVersionBadge.className = 'java-version-badge valid';
      hideJavaWarning();
    } else if (version) {
      javaVersionBadge.textContent = 'Java ' + version + ' (17+ requis)';
      javaVersionBadge.className = 'java-version-badge warning';
      showJavaWarning();
    } else {
      javaVersionBadge.textContent = 'Java non trouvé';
      javaVersionBadge.className = 'java-version-badge invalid';
      showJavaWarning();
    }
  }

  function validateJavaPath(p) {
    if (!p) { javaVersionInfo.classList.add('hidden'); return; }
    window.launcher.java.check().then(function (result) {
      if (result && result.found) showJavaVersion(result.version, getMajorVersion(result.version) >= 17);
      else showJavaVersion(null, false);
    });
  }

  function detectJavaAndUpdateUI() {
    window.launcher.settings.detectJava().then(function (result) {
      if (result && result.found) {
        settingJavaPath.value = result.path;
        showJavaVersion(result.version, getMajorVersion(result.version) >= 17);
      } else {
        settingJavaPath.value = '';
        showJavaVersion(null, false);
      }
    }).catch(function () { showJavaVersion(null, false); });
  }

  function startJavaDownload() {
    if (isDownloadingJava) return;
    isDownloadingJava = true;
    btnDownloadJava.disabled = true;
    javaDownloadProgress.classList.remove('hidden');
    javaDlLabel.textContent = 'Téléchargement de Java 17...';
    javaDlPercent.textContent = '0%';
    javaDlBarFill.style.width = '0%';

    window.launcher.java.onProgress(function (data) {
      if (data.status === 'downloading') {
        javaDlLabel.textContent = data.message || 'Téléchargement...';
        javaDlPercent.textContent = (data.percent || 0) + '%';
        javaDlBarFill.style.width = (data.percent || 0) + '%';
      } else if (data.status === 'extracting') {
        javaDlLabel.textContent = 'Extraction en cours...';
        javaDlPercent.textContent = '';
        javaDlBarFill.style.width = '100%';
      } else if (data.status === 'done') {
        javaDlLabel.textContent = 'Java 17 installé !';
        javaDlBarFill.style.width = '100%';
        javaDlBarFill.style.background = 'linear-gradient(90deg, var(--success) 0%, #27AE60 100%)';
        if (data.path) { settingJavaPath.value = data.path; showJavaVersion(data.version || '17', true); }
        hideJavaWarning();
        setTimeout(function () {
          javaDownloadProgress.classList.add('hidden');
          javaDlBarFill.style.background = '';
          isDownloadingJava = false;
          btnDownloadJava.disabled = false;
        }, 3000);
      } else if (data.status === 'error') {
        javaDlLabel.textContent = data.message || 'Erreur';
        javaDlBarFill.style.background = 'linear-gradient(90deg, var(--error) 0%, #C0392B 100%)';
        setTimeout(function () {
          javaDownloadProgress.classList.add('hidden');
          javaDlBarFill.style.background = '';
          isDownloadingJava = false;
          btnDownloadJava.disabled = false;
        }, 5000);
      }
    });

    window.launcher.java.download().catch(function () {
      isDownloadingJava = false;
      btnDownloadJava.disabled = false;
    });
  }

  settingRam.addEventListener('input', function () {
    settingRamValue.textContent = settingRam.value + ' Go';
  });

  function openSettings() {
    settingsOverlay.classList.remove('hidden', 'closing');
    loadSettings();
  }

  function closeSettings() {
    settingsOverlay.classList.add('closing');
    setTimeout(function () { settingsOverlay.classList.add('hidden'); settingsOverlay.classList.remove('closing'); }, 260);
  }

  btnDetectJava.addEventListener('click', detectJavaAndUpdateUI);
  btnBrowseJava.addEventListener('click', function () {
    window.launcher.settings.browseJava().then(function (result) {
      if (result && !result.canceled) {
        settingJavaPath.value = result.path;
        showJavaVersion(result.version, getMajorVersion(result.version) >= 17);
      }
    });
  });
  btnBrowseDir.addEventListener('click', function () {
    window.launcher.settings.browseDir().then(function (result) {
      if (result && !result.canceled) settingGameDir.value = result.path;
    });
  });
  btnDownloadJava.addEventListener('click', startJavaDownload);
  btnSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', closeSettings);
  settingsBackdrop.addEventListener('click', closeSettings);
  btnSaveSettings.addEventListener('click', function () {
    var settings = {
      ram: parseFloat(settingRam.value) || 4,
      javaPath: settingJavaPath.value,
      gameDir: settingGameDir.value,
      jvmArgs: settingJvmArgs.value,
      closeOnLaunch: settingCloseOnLaunch.checked,
      notifications: settingNotifications.checked,
      language: 'fr',
    };
    window.launcher.settings.save(settings).then(function () { closeSettings(); });
  });

  // ---- Mods optionnels ----
  var optionalModsState = {};

  function openModsPanel() {
    modsOverlay.classList.remove('hidden', 'closing');
    loadOptionalMods();
  }

  function closeModsPanel() {
    modsOverlay.classList.add('closing');
    setTimeout(function () { modsOverlay.classList.add('hidden'); modsOverlay.classList.remove('closing'); }, 260);
  }

  function loadOptionalMods() {
    modsListContainer.innerHTML = '<div class="news-loading"><div class="spinner"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div><span>Chargement...</span></div>';
    window.launcher.settings.get().then(function (settings) {
      var savedMods = (settings && settings.optionalMods) ? settings.optionalMods : {};
      window.launcher.game.fetchManifest().then(function (manifest) {
        if (!manifest || !manifest.allowedMods || manifest.allowedMods.length === 0) {
          modsListContainer.innerHTML = '<p class="setting-hint">Aucun mod optionnel disponible.</p>';
          return;
        }
        optionalModsState = {};
        var html = '';
        manifest.allowedMods.forEach(function (mod) {
          var fileName = mod.path.split('/').pop();
          var displayName = fileName.replace('.jar', '').replace(/[-_]/g, ' ');
          var sizeKB = Math.round(mod.size / 1024);
          var enabled = savedMods[fileName] === true;
          optionalModsState[fileName] = enabled;
          html += '<div class="setting-group"><div class="setting-toggle-row">'
            + '<div style="display:flex;flex-direction:column;">'
            + '<span class="setting-label">' + escapeHtml(displayName) + '</span>'
            + '<span class="setting-hint" style="margin:0;font-size:11px">' + escapeHtml(fileName) + ' (' + sizeKB + ' Ko)</span>'
            + '</div>'
            + '<label class="toggle"><input type="checkbox" class="mod-toggle" data-filename="' + escapeHtml(fileName) + '"' + (enabled ? ' checked' : '') + '>'
            + '<span class="toggle-slider"></span></label>'
            + '</div></div>';
        });
        modsListContainer.innerHTML = html;
        modsListContainer.querySelectorAll('.mod-toggle').forEach(function (toggle) {
          toggle.addEventListener('change', function () {
            optionalModsState[this.getAttribute('data-filename')] = this.checked;
          });
        });
      }).catch(function () {
        modsListContainer.innerHTML = '<p class="setting-hint" style="color:#E74C3C">Erreur de chargement. Vérifiez votre connexion.</p>';
      });
    });
  }

  btnOptionalMods.addEventListener('click', openModsPanel);
  btnCloseMods.addEventListener('click', closeModsPanel);
  modsBackdrop.addEventListener('click', closeModsPanel);
  btnSaveMods.addEventListener('click', function () {
    window.launcher.settings.get().then(function (settings) {
      if (!settings) settings = {};
      settings.optionalMods = optionalModsState;
      window.launcher.settings.save(settings).then(function () { closeModsPanel(); });
    });
  });

  // ---- Logout ----
  btnLogout.addEventListener('click', function () {
    window.launcher.auth.logout().then(function () {
      window.launcher.nav.goLogin();
    });
  });

  // ---- Window controls ----
  btnMinimize.addEventListener('click', function () { window.launcher.window.minimize(); });
  btnMaximize.addEventListener('click', function () { window.launcher.window.maximize(); });
  btnClose.addEventListener('click', function () { window.launcher.window.close(); });

  // ---- Logs ----
  linkLogs.addEventListener('click', function (e) {
    e.preventDefault();
    window.launcher.app.openLogs();
  });

  // ---- Helpers ----
  function escapeHtml(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  // ---- Start ----
  init();
})();
