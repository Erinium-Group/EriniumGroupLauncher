// ============================================================
// Login Screen — Microsoft Auth
// ============================================================

(function () {
  var btnMicrosoft = document.getElementById('btnMicrosoft');
  var btnClose = document.getElementById('btnClose');
  var btnQuit = document.getElementById('btnQuit');
  var btnRetry = document.getElementById('btnRetry');
  var loginActions = document.getElementById('loginActions');
  var loginLoading = document.getElementById('loginLoading');
  var loginError = document.getElementById('loginError');
  var errorMessage = document.getElementById('errorMessage');
  var versionText = document.getElementById('versionText');

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

  btnMicrosoft.addEventListener('click', function () {
    showState('loading');

    window.launcher.auth.startMicrosoft().then(function (result) {
      if (!result.success) {
        showError(result.error || 'Connexion Microsoft impossible.');
      }
      // En cas de succès, main.js ouvre la fenêtre principale
    }).catch(function (err) {
      showError('Erreur: ' + (err.message || 'Connexion impossible'));
    });
  });

  if (window.launcher && window.launcher.auth) {
    window.launcher.auth.onToken(function () {
      showState('loading');
    });

    window.launcher.auth.onError(function (data) {
      showError(data.message || 'Erreur d\'authentification.');
    });
  }

  btnRetry.addEventListener('click', function () {
    showState('idle');
  });

  btnClose.addEventListener('click', function () {
    window.launcher.app.quit();
  });

  btnQuit.addEventListener('click', function () {
    window.launcher.app.quit();
  });
})();
