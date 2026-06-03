// ============================================================
// Main Screen Logic
// ============================================================

(function () {
  // ---- DOM references ----
  var btnMinimize = document.getElementById('btnMinimize');
  var btnMaximize = document.getElementById('btnMaximize');
  var btnClose = document.getElementById('btnClose');
  var btnSettings = document.getElementById('btnSettings');
  var btnLogout = document.getElementById('btnLogout');
  var btnPlay = document.getElementById('btnPlay');
  var playText = document.getElementById('playText');
  var playIcon = document.getElementById('playIcon');
  var linkSite = document.getElementById('linkSite');

  // Profile elements
  var playerAvatar = document.getElementById('playerAvatar');
  var playerName = document.getElementById('playerName');
  var playerRank = document.getElementById('playerRank');
  var playerDiscord = document.getElementById('playerDiscord');
  var playerFaction = document.getElementById('playerFaction');
  var playerKills = document.getElementById('playerKills');
  var playerDeaths = document.getElementById('playerDeaths');
  var playerKD = document.getElementById('playerKD');

  // Server elements
  var serverDot = document.getElementById('serverDot');
  var serverStatusText = document.getElementById('serverStatusText');
  var serverPlayers = document.getElementById('serverPlayers');
  var serverTps = document.getElementById('serverTps');
  var playerBarFill = document.getElementById('playerBarFill');

  // News
  var newsList = document.getElementById('newsList');

  // Settings
  var settingsOverlay = document.getElementById('settingsOverlay');
  var settingsBackdrop = document.getElementById('settingsBackdrop');
  var btnCloseSettings = document.getElementById('btnCloseSettings');
  var btnSaveSettings = document.getElementById('btnSaveSettings');
  var settingRam = document.getElementById('settingRam');
  var settingRamValue = document.getElementById('settingRamValue');
  var settingRamHint = document.getElementById('settingRamHint');
  var settingJavaPath = document.getElementById('settingJavaPath');
  var settingGameDir = document.getElementById('settingGameDir');
  var settingJvmArgs = document.getElementById('settingJvmArgs');
  var settingCloseOnLaunch = document.getElementById('settingCloseOnLaunch');
  var settingNotifications = document.getElementById('settingNotifications');

  // Java detection elements
  var btnDetectJava = document.getElementById('btnDetectJava');
  var btnBrowseJava = document.getElementById('btnBrowseJava');
  var btnBrowseDir = document.getElementById('btnBrowseDir');
  var javaVersionInfo = document.getElementById('javaVersionInfo');
  var javaVersionBadge = document.getElementById('javaVersionBadge');
  var settingJavaHint = document.getElementById('settingJavaHint');
  var javaWarningBanner = document.getElementById('javaWarningBanner');
  var btnDownloadJava = document.getElementById('btnDownloadJava');
  var javaDownloadProgress = document.getElementById('javaDownloadProgress');
  var javaDlLabel = document.getElementById('javaDlLabel');
  var javaDlPercent = document.getElementById('javaDlPercent');
  var javaDlBarFill = document.getElementById('javaDlBarFill');

  // Optional Mods
  var modsOverlay = document.getElementById('modsOverlay');
  var modsBackdrop = document.getElementById('modsBackdrop');
  var btnOptionalMods = document.getElementById('btnOptionalMods');
  var btnCloseMods = document.getElementById('btnCloseMods');
  var btnSaveMods = document.getElementById('btnSaveMods');
  var modsListContainer = document.getElementById('modsListContainer');

  // Footer
  var footerVersion = document.getElementById('footerVersion');

  // ---- State ----
  var serverOnline = false;
  var isPlaying = false;
  var statusPollInterval = null;

  // ---- Init ----
  function init() {
    loadVersion();
    loadProfile();
    loadServerStatus();
    loadNews();
    loadSettings();

    // Poll server status every 30 seconds
    statusPollInterval = setInterval(loadServerStatus, 30000);
  }

  // ---- Version ----
  function loadVersion() {
    window.launcher.app.getVersion().then(function (v) {
      footerVersion.textContent = v;
    });
  }

  // ---- Minecraft color/format codes parser ----
  // Parses strings containing Minecraft formatting codes (§ or &) and returns
  // safe HTML with inline styles. Supports colors §0-9a-f, formats §l/m/n/o, reset §r.
  // The plain text content is HTML-escaped so the input is safe to render.
  var MC_COLORS = {
    '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
    '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
    '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
    'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF'
  };

  function escapeHtmlChars(text) {
    return text.replace(/[&<>"']/g, function (c) {
      return ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[c];
    });
  }

  function parseMcCodes(input) {
    if (input == null) return '';
    var str = String(input);
    // Normalize section sign and ampersand to a single placeholder
    var normalized = str.replace(/§/g, '§').replace(/&([0-9a-fk-orA-FK-OR])/g, '§$1');

    var html = '';
    var color = null;
    var bold = false;
    var italic = false;
    var underline = false;
    var strike = false;
    var openSpan = false;
    var buf = '';

    function flushBuf() {
      if (buf.length === 0) return;
      var styles = [];
      if (color) styles.push('color:' + color);
      if (bold) styles.push('font-weight:700');
      if (italic) styles.push('font-style:italic');
      var deco = [];
      if (underline) deco.push('underline');
      if (strike) deco.push('line-through');
      if (deco.length > 0) styles.push('text-decoration:' + deco.join(' '));
      if (styles.length > 0) {
        html += '<span style="' + styles.join(';') + '">' + escapeHtmlChars(buf) + '</span>';
      } else {
        html += escapeHtmlChars(buf);
      }
      buf = '';
      openSpan = false;
    }

    for (var i = 0; i < normalized.length; i++) {
      var ch = normalized.charAt(i);
      if (ch === '§' && i + 1 < normalized.length) {
        var code = normalized.charAt(i + 1).toLowerCase();
        flushBuf();
        if (MC_COLORS[code]) {
          color = MC_COLORS[code];
          // Color code resets formatting in vanilla Minecraft
          bold = false; italic = false; underline = false; strike = false;
        } else if (code === 'l') {
          bold = true;
        } else if (code === 'o') {
          italic = true;
        } else if (code === 'n') {
          underline = true;
        } else if (code === 'm') {
          strike = true;
        } else if (code === 'r') {
          color = null; bold = false; italic = false; underline = false; strike = false;
        }
        // 'k' (obfuscated) is ignored — render as-is
        i++; // skip the code char
        continue;
      }
      buf += ch;
      openSpan = true;
    }
    flushBuf();
    return html;
  }

  // ---- Profile ----
  function loadProfile() {
    window.launcher.auth.getSession().then(function (session) {
      if (session && session.valid && session.user) {
        var user = session.user;
        // Default rendering from the cached session (no rank prefix yet).
        // The rank prefix is fetched separately below from the live API.
        playerName.innerHTML = escapeHtmlChars(user.mcName || 'Joueur');
        playerDiscord.textContent = user.discordName || '';

        // Avatar (URL complète depuis le site, ou reconstruit depuis discordId + hash)
        if (user.avatar) {
          if (user.avatar.startsWith('http')) {
            playerAvatar.src = user.avatar;
          } else if (user.discordId) {
            playerAvatar.src = 'https://cdn.discordapp.com/avatars/' + user.discordId + '/' + user.avatar + '.png?size=128';
          }
        }

        // Stats
        playerFaction.textContent = user.faction || 'Aucune';
        playerKills.textContent = (user.kills || 0).toString();
        playerDeaths.textContent = (user.deaths || 0).toString();
        var deaths = user.deaths || 0;
        var kills = user.kills || 0;
        var kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
        playerKD.textContent = kd;

        // Fetch the live rank prefix and update the display.
        loadRankPrefix(user.mcName || 'Joueur');
      }
    });
  }

  // Fetches the player profile (MC name + rank prefix) from the site API
  // and renders the rank prefix in front of the player name. Falls back to
  // showing just the MC name if anything fails.
  function loadRankPrefix(fallbackName) {
    window.launcher.auth.getProfile().then(function (profile) {
      if (!profile) {
        playerName.innerHTML = escapeHtmlChars(fallbackName);
        return;
      }

      var mcName = profile.mcName || fallbackName;
      var prefix = profile.prefix || '';
      var rankName = profile.rankName || '';
      var color = profile.color || '';

      // Render: <prefix><colored mc name>
      // If a rank color is provided, color the player name with it (after the prefix).
      var nameHtml;
      if (color) {
        nameHtml = parseMcCodes(color + mcName);
      } else {
        nameHtml = escapeHtmlChars(mcName);
      }
      playerName.innerHTML = parseMcCodes(prefix) + nameHtml;

      // Update the rank badge with the parsed rank name.
      var badge = playerRank.querySelector('.rank-badge');
      if (rankName) {
        badge.innerHTML = parseMcCodes(rankName);
        // Apply the rank color to the badge background/border too.
        if (color) {
          var hex = mcCodeToHex(color);
          if (hex) {
            badge.style.color = hex;
            badge.style.borderColor = hex + '4D';
            badge.style.background = hex + '1A';
          }
        }
      } else {
        badge.textContent = 'Joueur';
      }
    }).catch(function () {
      playerName.innerHTML = escapeHtmlChars(fallbackName);
    });
  }

  // Returns the hex color of the LAST color code found in the string, or null.
  function mcCodeToHex(str) {
    if (!str) return null;
    var normalized = String(str).replace(/&([0-9a-fA-F])/g, '§$1');
    var lastHex = null;
    for (var i = 0; i < normalized.length - 1; i++) {
      if (normalized.charAt(i) === '§') {
        var c = normalized.charAt(i + 1).toLowerCase();
        if (MC_COLORS[c]) lastHex = MC_COLORS[c];
      }
    }
    return lastHex;
  }

  // ---- Server Status ----
  function loadServerStatus() {
    window.launcher.server.getStatus().then(function (status) {
      if (status && status.online) {
        serverOnline = true;
        serverDot.className = 'status-dot online';
        serverStatusText.textContent = 'En ligne';
        serverStatusText.style.color = '#2ECC71';
        var current = (status.players && typeof status.players === 'object') ? (status.players.current || 0) : (status.players || 0);
        var max = (status.players && typeof status.players === 'object') ? (status.players.max || 1000) : (status.maxPlayers || 1000);
        serverPlayers.textContent = current + ' / ' + max;
        var tps = status.tps || 0;
        serverTps.textContent = tps.toFixed(1);
        serverTps.className = 'server-stat-value';
        if (tps >= 19) {
          serverTps.classList.add('tps-good');
        } else if (tps >= 15) {
          serverTps.classList.add('tps-warn');
        } else {
          serverTps.classList.add('tps-bad');
        }
        var percent = Math.min(100, (current / max) * 100);
        playerBarFill.style.width = percent + '%';

        if (!isPlaying && !isGameBusy()) {
          setPlayButtonState('default', 'JOUER');
        }
      } else {
        serverOnline = false;
        serverDot.className = 'status-dot offline';
        serverStatusText.textContent = 'Hors ligne';
        serverStatusText.style.color = '#E74C3C';
        serverPlayers.textContent = '0 / 1000';
        serverTps.textContent = '-';
        serverTps.className = 'server-stat-value';
        playerBarFill.style.width = '0%';

        // Le bouton JOUER reste actif même si le serveur est offline
        // Le joueur peut lancer le jeu à l'avance (preshot)
        if (!isPlaying && !isGameBusy()) {
          setPlayButtonState('default', 'JOUER');
        }
      }
    }).catch(function () {
      serverOnline = false;
      serverDot.className = 'status-dot offline';
      serverStatusText.textContent = 'Hors ligne';
      serverStatusText.style.color = '#E74C3C';
    });
  }

  // ---- News ----
  function loadNews() {
    window.launcher.news.getLatest().then(function (articles) {
      newsList.innerHTML = '';
      if (!articles || articles.length === 0) {
        newsList.innerHTML = '<p class="news-empty">Aucune actualite pour le moment.</p>';
        return;
      }

      articles.forEach(function (article) {
        var item = document.createElement('div');
        item.className = 'news-item';
        var summary = article.summary || article.excerpt || '';
        var tagHtml = article.tag ? '<span class="news-tag">' + escapeHtml(article.tag) + '</span>' : '';
        item.innerHTML =
          '<div class="news-dot"></div>' +
          '<div class="news-content">' +
          '<div class="news-header">' + tagHtml + '<span class="news-date">' + (article.date || '') + '</span></div>' +
          '<div class="news-title">' + escapeHtml(article.title || 'Sans titre') + '</div>' +
          (summary ? '<div class="news-summary">' + escapeHtml(summary) + '</div>' : '') +
          '</div>';
        item.addEventListener('click', function () {
          var newsUrl = article.slug
            ? 'https://eriniumgroup.vercel.app/news/' + article.slug
            : 'https://eriniumgroup.vercel.app/news';
          window.launcher.shell.openExternal(newsUrl);
        });
        newsList.appendChild(item);
      });
    }).catch(function () {
      newsList.innerHTML = '<p class="news-empty">Impossible de charger les actualites.</p>';
    });
  }

  // Auto-refresh news every 5 minutes
  setInterval(loadNews, 5 * 60 * 1000);

  // ---- Game progress elements ----
  var gameProgress = document.getElementById('gameProgress');
  var gameProgressLabel = document.getElementById('gameProgressLabel');
  var gameProgressPercent = document.getElementById('gameProgressPercent');
  var gameProgressFill = document.getElementById('gameProgressFill');
  var gameProgressDetail = document.getElementById('gameProgressDetail');

  // ---- Play button state management ----
  var lastError = null;

  function setPlayButtonState(state, text) {
    // Remove all state classes
    btnPlay.className = 'btn btn-play';

    // Remove existing spinner
    var existingSpinner = btnPlay.querySelector('.play-spinner');
    if (existingSpinner) existingSpinner.remove();

    switch (state) {
      case 'default':
        btnPlay.disabled = false;
        playIcon.textContent = '\u25B6';
        playText.textContent = text || 'JOUER';
        break;

      case 'checking':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-checking');
        playIcon.textContent = '';
        var spinner1 = document.createElement('div');
        spinner1.className = 'play-spinner';
        btnPlay.insertBefore(spinner1, playText);
        playText.textContent = text || 'VERIFICATION...';
        break;

      case 'downloading':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-downloading');
        playIcon.textContent = '';
        var spinner2 = document.createElement('div');
        spinner2.className = 'play-spinner';
        btnPlay.insertBefore(spinner2, playText);
        playText.textContent = text || 'TELECHARGEMENT...';
        break;

      case 'installing':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-installing');
        playIcon.textContent = '';
        var spinner3 = document.createElement('div');
        spinner3.className = 'play-spinner';
        btnPlay.insertBefore(spinner3, playText);
        playText.textContent = text || 'INSTALLATION...';
        break;

      case 'launching':
        btnPlay.disabled = true;
        btnPlay.classList.add('state-launching');
        playIcon.textContent = '';
        var spinner4 = document.createElement('div');
        spinner4.className = 'play-spinner';
        btnPlay.insertBefore(spinner4, playText);
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
        playText.textContent = text || 'ERREUR — CLIQUER POUR REESSAYER';
        break;
    }
  }

  function showProgress(step, percent, detail) {
    gameProgress.classList.remove('hidden');
    gameProgressLabel.textContent = step || '';
    gameProgressDetail.textContent = detail || '';

    if (percent < 0) {
      // Indeterminate
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

  // ---- Wire up progress and status events ----
  window.launcher.game.onProgress(function (data) {
    showProgress(data.step, data.percent, data.detail);
  });

  window.launcher.game.onStatus(function (data) {
    switch (data.status) {
      case 'checking':
        setPlayButtonState('checking', 'VERIFICATION...');
        break;
      case 'downloading':
        setPlayButtonState('downloading', 'TELECHARGEMENT...');
        break;
      case 'installing':
        setPlayButtonState('installing', 'INSTALLATION...');
        break;
      case 'launching':
        setPlayButtonState('launching', 'LANCEMENT...');
        break;
      case 'playing':
        setPlayButtonState('playing', 'EN JEU');
        // Hide progress bar after a short delay when playing
        setTimeout(hideProgress, 2000);
        break;
      case 'closed':
        resetPlayButton();
        break;
      case 'error':
        lastError = data.message;
        setPlayButtonState('error', 'ERREUR — CLIQUER POUR REESSAYER');
        // Show error in progress detail
        showProgress('Erreur', 0, data.message || 'Une erreur est survenue');
        break;
    }
  });

  // ---- Play button click ----
  btnPlay.addEventListener('click', function () {
    if (isPlaying) return;

    // If in error state, clicking retries
    if (btnPlay.classList.contains('state-error')) {
      lastError = null;
    }

    // Before launching, check Java
    window.launcher.java.check().then(function (javaResult) {
      if (!javaResult || !javaResult.found) {
        // No Java found — open settings with the warning visible
        openSettings();
        showJavaWarning();
        return;
      }

      // Java OK — proceed with launch
      setPlayButtonState('checking', 'VERIFICATION...');
      showProgress('Demarrage...', 0, '');

      window.launcher.game.launch().then(function (result) {
        if (result && result.success) {
          // Status updates will come via IPC events
          console.log('[Launcher] Game launched successfully');
        } else {
          lastError = (result && result.error) || 'Erreur inconnue';
          setPlayButtonState('error', 'ERREUR — CLIQUER POUR REESSAYER');
          showProgress('Erreur', 0, lastError);
        }
      }).catch(function (err) {
        lastError = err.message || 'Erreur inconnue';
        setPlayButtonState('error', 'ERREUR — CLIQUER POUR REESSAYER');
        showProgress('Erreur', 0, lastError);
      });
    }).catch(function () {
      openSettings();
      showJavaWarning();
    });
  });

  // ---- Settings ----
  var isDownloadingJava = false;

  function loadSettings() {
    window.launcher.settings.get().then(function (s) {
      settingRam.value = s.ram || 4;
      settingRamValue.textContent = (s.ram || 4) + ' Go';
      settingJavaPath.value = s.javaPath || '';
      settingGameDir.value = s.gameDir || '';
      settingJvmArgs.value = s.jvmArgs || '';
      settingCloseOnLaunch.checked = !!s.closeOnLaunch;
      settingNotifications.checked = s.notifications !== false;

      // Auto-detect Java if no path set
      if (!s.javaPath) {
        detectJavaAndUpdateUI();
      } else {
        validateJavaPath(s.javaPath);
      }
    });

    // System RAM hint
    settingRamHint.textContent = 'Ajustez selon vos besoins. Recommande: 4 Go minimum.';
  }

  function showJavaWarning() {
    javaWarningBanner.classList.remove('hidden');
  }

  function hideJavaWarning() {
    javaWarningBanner.classList.add('hidden');
  }

  function showJavaVersion(version, isValid) {
    javaVersionInfo.classList.remove('hidden');
    if (isValid) {
      javaVersionBadge.textContent = 'Java ' + version + ' detecte';
      javaVersionBadge.className = 'java-version-badge valid';
      hideJavaWarning();
    } else if (version) {
      // Java found but old version
      javaVersionBadge.textContent = 'Java ' + version + ' (21+ recommande)';
      javaVersionBadge.className = 'java-version-badge warning';
      hideJavaWarning();
    } else {
      javaVersionBadge.textContent = 'Java non trouve';
      javaVersionBadge.className = 'java-version-badge invalid';
      showJavaWarning();
    }
  }

  function validateJavaPath(javaPath) {
    if (!javaPath) {
      javaVersionInfo.classList.add('hidden');
      return;
    }
    // Use the detect IPC to validate the path
    window.launcher.java.check().then(function (result) {
      if (result && result.found) {
        var major = getMajorVersionClient(result.version);
        showJavaVersion(result.version, major >= 21);
      } else {
        showJavaVersion(null, false);
      }
    });
  }

  function getMajorVersionClient(versionStr) {
    if (!versionStr) return 0;
    var parts = versionStr.split(/[._-]/);
    var major = parseInt(parts[0], 10);
    if (major === 1 && parts.length > 1) return parseInt(parts[1], 10);
    return major;
  }

  function detectJavaAndUpdateUI() {
    btnDetectJava.classList.add('detecting');
    btnDetectJava.querySelector('svg').style.animation = 'spin 1s linear infinite';

    window.launcher.settings.detectJava().then(function (result) {
      btnDetectJava.classList.remove('detecting');
      btnDetectJava.querySelector('svg').style.animation = '';

      if (result && result.found) {
        settingJavaPath.value = result.path;
        var major = getMajorVersionClient(result.version);
        showJavaVersion(result.version, major >= 21);
      } else {
        settingJavaPath.value = '';
        showJavaVersion(null, false);
      }
    }).catch(function () {
      btnDetectJava.classList.remove('detecting');
      btnDetectJava.querySelector('svg').style.animation = '';
      showJavaVersion(null, false);
    });
  }

  function startJavaDownload() {
    if (isDownloadingJava) return;
    isDownloadingJava = true;

    btnDownloadJava.disabled = true;
    javaDownloadProgress.classList.remove('hidden');
    javaDlLabel.textContent = 'Telechargement de Java 21...';
    javaDlPercent.textContent = '0%';
    javaDlBarFill.style.width = '0%';

    // Listen for progress
    window.launcher.java.onProgress(function (data) {
      if (data.status === 'downloading') {
        javaDlLabel.textContent = data.message || 'Telechargement...';
        javaDlPercent.textContent = (data.percent || 0) + '%';
        javaDlBarFill.style.width = (data.percent || 0) + '%';
      } else if (data.status === 'extracting') {
        javaDlLabel.textContent = 'Extraction en cours...';
        javaDlPercent.textContent = '';
        javaDlBarFill.style.width = '100%';
      } else if (data.status === 'done') {
        javaDlLabel.textContent = 'Java 21 installe avec succes !';
        javaDlPercent.textContent = '';
        javaDlBarFill.style.width = '100%';
        javaDlBarFill.style.background = 'linear-gradient(90deg, var(--success) 0%, #27AE60 100%)';

        // Update the path
        if (data.path) {
          settingJavaPath.value = data.path;
          showJavaVersion(data.version || '21', true);
        }
        hideJavaWarning();

        // Hide progress after a moment
        setTimeout(function () {
          javaDownloadProgress.classList.add('hidden');
          javaDlBarFill.style.background = '';
          isDownloadingJava = false;
          btnDownloadJava.disabled = false;
        }, 3000);
      } else if (data.status === 'error') {
        javaDlLabel.textContent = data.message || 'Erreur';
        javaDlPercent.textContent = '';
        javaDlBarFill.style.width = '100%';
        javaDlBarFill.style.background = 'linear-gradient(90deg, var(--error) 0%, #C0392B 100%)';

        setTimeout(function () {
          javaDownloadProgress.classList.add('hidden');
          javaDlBarFill.style.background = '';
          isDownloadingJava = false;
          btnDownloadJava.disabled = false;
        }, 5000);
      }
    });

    window.launcher.java.download().then(function (result) {
      if (result && result.success) {
        settingJavaPath.value = result.path;
        showJavaVersion(result.version, true);
        hideJavaWarning();
      }
    }).catch(function (err) {
      console.error('Java download failed:', err);
      isDownloadingJava = false;
      btnDownloadJava.disabled = false;
    });
  }

  settingRam.addEventListener('input', function () {
    settingRamValue.textContent = settingRam.value + ' Go';
  });

  function openSettings() {
    settingsOverlay.classList.remove('hidden');
    settingsOverlay.classList.remove('closing');
    loadSettings();
  }

  function closeSettings() {
    settingsOverlay.classList.add('closing');
    setTimeout(function () {
      settingsOverlay.classList.add('hidden');
      settingsOverlay.classList.remove('closing');
    }, 260);
  }

  // Wire buttons
  btnDetectJava.addEventListener('click', detectJavaAndUpdateUI);

  btnBrowseJava.addEventListener('click', function () {
    window.launcher.settings.browseJava().then(function (result) {
      if (result && !result.canceled) {
        settingJavaPath.value = result.path;
        if (result.version) {
          var major = getMajorVersionClient(result.version);
          showJavaVersion(result.version, major >= 21);
        } else {
          showJavaVersion(null, false);
        }
      }
    });
  });

  btnBrowseDir.addEventListener('click', function () {
    window.launcher.settings.browseDir().then(function (result) {
      if (result && !result.canceled) {
        settingGameDir.value = result.path;
      }
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
    window.launcher.settings.save(settings).then(function () {
      closeSettings();
    });
  });

  // ---- Optional Mods ----
  var optionalModsState = {}; // { filename: true/false }

  function openModsPanel() {
    modsOverlay.classList.remove('hidden');
    modsOverlay.classList.remove('closing');
    loadOptionalMods();
  }

  function closeModsPanel() {
    modsOverlay.classList.add('closing');
    setTimeout(function () {
      modsOverlay.classList.add('hidden');
      modsOverlay.classList.remove('closing');
    }, 260);
  }

  function loadOptionalMods() {
    modsListContainer.innerHTML = '<div class="news-loading"><div class="spinner"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div><span>Chargement...</span></div>';

    // Load saved state
    window.launcher.settings.get().then(function (settings) {
      var savedMods = (settings && settings.optionalMods) ? settings.optionalMods : {};

      // Fetch manifest to get allowed mods
      window.launcher.game.fetchManifest().then(function (manifest) {
        if (!manifest || !manifest.allowedMods || manifest.allowedMods.length === 0) {
          modsListContainer.innerHTML = '<p class="setting-hint">Aucun mod optionnel disponible pour le moment.</p>';
          return;
        }

        optionalModsState = {};
        var html = '';
        for (var i = 0; i < manifest.allowedMods.length; i++) {
          var mod = manifest.allowedMods[i];
          var fileName = mod.path.split('/').pop();
          var displayName = fileName.replace('.jar', '').replace(/-/g, ' ').replace(/_/g, ' ');
          var sizeKB = Math.round(mod.size / 1024);
          var enabled = savedMods[fileName] === true;
          optionalModsState[fileName] = enabled;

          html += '<div class="setting-group">'
            + '<div class="setting-toggle-row">'
            + '<div style="display:flex; flex-direction:column;">'
            + '<span class="setting-label">' + displayName + '</span>'
            + '<span class="setting-hint" style="margin:0; font-size:11px">' + fileName + ' (' + sizeKB + ' Ko)</span>'
            + '</div>'
            + '<label class="toggle">'
            + '<input type="checkbox" class="mod-toggle" data-filename="' + fileName + '"' + (enabled ? ' checked' : '') + '>'
            + '<span class="toggle-slider"></span>'
            + '</label>'
            + '</div>'
            + '</div>';
        }

        modsListContainer.innerHTML = html;

        // Wire toggle events
        var toggles = modsListContainer.querySelectorAll('.mod-toggle');
        for (var j = 0; j < toggles.length; j++) {
          toggles[j].addEventListener('change', function () {
            optionalModsState[this.getAttribute('data-filename')] = this.checked;
          });
        }
      }).catch(function () {
        modsListContainer.innerHTML = '<p class="setting-hint" style="color: #E74C3C;">Erreur lors du chargement. Verifiez votre connexion.</p>';
      });
    });
  }

  btnOptionalMods.addEventListener('click', openModsPanel);
  btnCloseMods.addEventListener('click', closeModsPanel);
  modsBackdrop.addEventListener('click', closeModsPanel);

  btnSaveMods.addEventListener('click', function () {
    // Save optional mods state to settings
    window.launcher.settings.get().then(function (settings) {
      if (!settings) settings = {};
      settings.optionalMods = optionalModsState;
      window.launcher.settings.save(settings).then(function () {
        closeModsPanel();
      });
    });
  });

  // ---- Logout ----
  btnLogout.addEventListener('click', function () {
    window.launcher.auth.logout().then(function () {
      if (statusPollInterval) clearInterval(statusPollInterval);
      window.launcher.nav.goLogin();
    });
  });

  // ---- Window controls ----
  btnMinimize.addEventListener('click', function () {
    window.launcher.window.minimize();
  });
  btnMaximize.addEventListener('click', function () {
    window.launcher.window.maximize();
  });
  btnClose.addEventListener('click', function () {
    window.launcher.window.close();
  });

  // ---- Site link ----
  linkSite.addEventListener('click', function (e) {
    e.preventDefault();
    window.launcher.shell.openExternal('https://eriniumgroup.vercel.app');
  });

  // ---- Helpers ----
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatRelativeDate(dateStr) {
    if (!dateStr) return '';
    try {
      var date = new Date(dateStr);
      var now = new Date();
      var diffMs = now - date;
      var diffMin = Math.floor(diffMs / 60000);
      var diffHours = Math.floor(diffMs / 3600000);
      var diffDays = Math.floor(diffMs / 86400000);

      if (diffMin < 1) return "A l'instant";
      if (diffMin < 60) return 'Il y a ' + diffMin + ' min';
      if (diffHours < 24) return 'Il y a ' + diffHours + ' heure' + (diffHours > 1 ? 's' : '');
      if (diffDays < 30) return 'Il y a ' + diffDays + ' jour' + (diffDays > 1 ? 's' : '');
      return date.toLocaleDateString('fr-FR');
    } catch (e) {
      return '';
    }
  }

  // ---- Start ----
  init();
})();
