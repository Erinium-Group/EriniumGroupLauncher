// ============================================================
// Login Screen Logic
// ============================================================

(function () {
  var btnDiscord = document.getElementById('btnDiscord');
  var btnDevLogin = document.getElementById('btnDevLogin');
  var btnClose = document.getElementById('btnClose');
  var btnQuit = document.getElementById('btnQuit');
  var btnRetry = document.getElementById('btnRetry');
  var linkCgv = document.getElementById('linkCgv');
  var loginActions = document.getElementById('loginActions');
  var loginLoading = document.getElementById('loginLoading');
  var loginError = document.getElementById('loginError');
  var errorMessage = document.getElementById('errorMessage');
  var versionText = document.getElementById('versionText');

  // Set version
  if (window.launcher && window.launcher.app) {
    window.launcher.app.getVersion().then(function (v) {
      versionText.textContent = 'v' + v;
    });
  }

  function showState(state) {
    loginActions.classList.toggle('hidden', state !== 'idle');
    loginLoading.classList.toggle('hidden', state !== 'loading');
    loginError.classList.toggle('hidden', state !== 'error');
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    showState('error');
  }

  // Discord login
  btnDiscord.addEventListener('click', function () {
    showState('loading');

    window.launcher.auth.startDiscord().then(function (result) {
      if (!result.success) {
        showError(result.error || 'Impossible de demarrer la connexion Discord.');
      }
      // Otherwise, we wait for the callback via IPC
      // Set a timeout of 2 minutes
      setTimeout(function () {
        if (!loginLoading.classList.contains('hidden')) {
          showError('La connexion a expire. Reessayez.');
        }
      }, 120000);
    }).catch(function (err) {
      showError('Erreur: ' + (err.message || 'Connexion impossible'));
    });
  });

  // Show dev button only in development (not packaged)
  if (window.launcher && window.launcher.app && window.launcher.app.isDev) {
    window.launcher.app.isDev().then(function (isDev) {
      if (isDev && btnDevLogin) btnDevLogin.classList.remove('hidden');
    });
  }

  // Dev login (simulated)
  btnDevLogin.addEventListener('click', function () {
    showState('loading');

    window.launcher.auth.devLogin().then(function (result) {
      if (result.success) {
        // Navigate to main window
        window.launcher.nav.goMain();
      } else {
        showError('Echec de la connexion dev.');
      }
    }).catch(function (err) {
      showError('Erreur: ' + (err.message || 'Connexion dev impossible'));
    });
  });

  // Listen for auth events
  if (window.launcher && window.launcher.auth) {
    window.launcher.auth.onToken(function (user) {
      // Auth succeeded — main process will open main window
      showState('loading');
    });

    window.launcher.auth.onError(function (data) {
      showError(data.message || 'Erreur d\'authentification.');
    });
  }

  // Retry
  btnRetry.addEventListener('click', function () {
    showState('idle');
  });

  // Close / Quit
  btnClose.addEventListener('click', function () {
    window.launcher.app.quit();
  });

  btnQuit.addEventListener('click', function () {
    window.launcher.app.quit();
  });

  // CGV link
  linkCgv.addEventListener('click', function (e) {
    e.preventDefault();
    window.launcher.shell.openExternal('https://eriniumgroup.vercel.app/cgv');
  });
})();
