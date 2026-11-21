/* ==========================================
   KULZZY UNIVERSAL MEDIA CONTROLLER
   VERSION 3.0
   FIREBASE CENTRAL CONTROL
========================================== */

(function () {
  "use strict";

  if (window.KULZZY_UNIVERSAL_MEDIA_CONTROL) return;

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDVq__Tr9pxBL6pSTqZVOEOLRVN9sYtYzc",
    authDomain: "kulzzy-universal-media-control.firebaseapp.com",
    databaseURL: "https://kulzzy-universal-media-control-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "kulzzy-universal-media-control",
    storageBucket: "kulzzy-universal-media-control.firebasestorage.app",
    messagingSenderId: "580659270014",
    appId: "1:580659270014:web:832b646991e030584c232f"
  };

  const SDK_VERSION = "10.12.2";
  const APP_NAME = "KULZZY_UNIVERSAL_MEDIA_CONTROL";
  const PLAYER_CONFIG = window.KULZZY_MEDIA_PLAYER_CONFIG || {};

  const PLAYER_ID = String(
    PLAYER_CONFIG.playerId ||
    location.hostname + location.pathname
  );

  const PLAYER_NAME = String(
    PLAYER_CONFIG.playerName || PLAYER_ID
  );

  const MEDIA_SELECTOR = PLAYER_CONFIG.mediaSelector || "audio,video";

  let firebaseApp = null;
  let auth = null;
  let database = null;
  let playerRef = null;
  let playersRef = null;
  let userId = null;

  let ready = false;
  let registeredPlaying = false;
  let stoppingByController = false;
  let stopTimer = null;

  function log() {
    console.log("[Kulzzy Universal Media]", ...arguments);
  }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector(
        'script[data-kulzzy-sdk="' + url + '"]'
      );

      if (existing) {
        if (existing.dataset.loaded === "true") {
          resolve();
          return;
        }

        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.dataset.kulzzySdk = url;

      script.onload = function () {
        script.dataset.loaded = "true";
        resolve();
      };

      script.onerror = reject;

      document.head.appendChild(script);
    });
  }

  async function loadFirebase() {
    const base =
      "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";

    await loadScript(base + "firebase-app-compat.js");
    await loadScript(base + "firebase-auth-compat.js");
    await loadScript(base + "firebase-database-compat.js");

    const existing = firebase.apps.find(function (app) {
      return app.name === APP_NAME;
    });

    firebaseApp = existing ||
      firebase.initializeApp(FIREBASE_CONFIG, APP_NAME);

    auth = firebaseApp.auth();
    database = firebaseApp.database();
  }

  function getMediaElements() {
    try {
      return Array.from(
        document.querySelectorAll(MEDIA_SELECTOR)
      );
    } catch (error) {
      console.error(
        "[Kulzzy Universal Media] Invalid media selector.",
        error
      );
      return [];
    }
  }

  function isLocallyPlaying() {
    return getMediaElements().some(function (media) {
      return !media.paused && !media.ended;
    });
  }

  function removeOwnRegistration() {
    if (!ready || !playerRef) return Promise.resolve();

    registeredPlaying = false;

    return playerRef.remove().catch(function (error) {
      console.error(
        "[Kulzzy Universal Media] Could not clear player status:",
        error
      );
    });
  }

  function registerPlaying() {
    if (!ready || !playerRef || stoppingByController) return;

    if (registeredPlaying) return;

    registeredPlaying = true;

    playerRef.set({
      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,
      playing: true,
      startedAt: firebase.database.ServerValue.TIMESTAMP
    }).catch(function (error) {
      registeredPlaying = false;

      console.error(
        "[Kulzzy Universal Media] Registration failed:",
        error
      );
    });

    log("Player started:", PLAYER_NAME);
  }

  function notifyStop() {
    clearTimeout(stopTimer);

    if (!registeredPlaying) return;

    removeOwnRegistration();

    log("Player stopped:", PLAYER_NAME);
  }

  function notifyPlay() {
    clearTimeout(stopTimer);

    registerPlaying();
  }

  function stopLocalPlayer(reason) {
    if (stoppingByController) return;

    stoppingByController = true;

    log("Stopping this player. Another player has taken control.");

    window.dispatchEvent(
      new CustomEvent("kulzzy:media-stop", {
        detail: {
          reason: reason || "another-player-started",
          controller: "KULZZY_UNIVERSAL_MEDIA_CONTROL"
        }
      })
    );

    window.postMessage({
      type: "KULZZY_UNIVERSAL_MEDIA_STOP",
      reason: reason || "another-player-started"
    }, "*");

    if (typeof PLAYER_CONFIG.stop === "function") {
      try {
        PLAYER_CONFIG.stop();
      } catch (error) {
        console.error(
          "[Kulzzy Universal Media] Custom stop failed:",
          error
        );
      }
    }

    getMediaElements().forEach(function (media) {
      try {
        media.pause();
      } catch (error) {
        console.error(error);
      }
    });

    removeOwnRegistration();

    setTimeout(function () {
      stoppingByController = false;
    }, 500);
  }

  function findWinningPlayer(snapshot) {
    const active = [];

    snapshot.forEach(function (child) {
      const data = child.val();

      if (!data || data.playing !== true) return;

      active.push({
        uid: child.key,
        playerId: data.playerId || child.key,
        playerName: data.playerName || data.playerId || "Player",
        startedAt: Number(data.startedAt) || 0
      });
    });

    active.sort(function (a, b) {
      if (a.startedAt !== b.startedAt) {
        return b.startedAt - a.startedAt;
      }

      return b.uid.localeCompare(a.uid);
    });

    return active.length ? active[0] : null;
  }

  function monitorPlayers() {
    playersRef.on("value", function (snapshot) {
      const winner = findWinningPlayer(snapshot);

      if (!winner) {
        log("No active player.");
        return;
      }

      if (winner.uid !== userId) {
        if (isLocallyPlaying() || registeredPlaying) {
          stopLocalPlayer(
            "Playback taken by " + winner.playerName
          );
        }
      } else {
        log("This player currently has control:", PLAYER_NAME);
      }
    }, function (error) {
      console.error(
        "[Kulzzy Universal Media] Monitoring failed:",
        error
      );
    });
  }

  function handleMediaEvent(event) {
    if (stoppingByController) return;

    const target = event.target;

    if (!target || typeof target.matches !== "function") return;

    if (!target.matches(MEDIA_SELECTOR)) return;

    if (event.type === "play" || event.type === "playing") {
      notifyPlay();
      return;
    }

    if (
      event.type === "pause" ||
      event.type === "ended" ||
      event.type === "error"
    ) {
      clearTimeout(stopTimer);

      stopTimer = setTimeout(function () {
        if (!isLocallyPlaying()) {
          notifyStop();
        }
      }, 150);
    }
  }

  async function startController(user) {
    if (ready || !user) return;

    userId = user.uid;

    playerRef = database.ref(
      "control/players/" + userId
    );

    playersRef = database.ref("control/players");

    try {
      await playerRef.onDisconnect().remove();

      ready = true;

      monitorPlayers();

      log("Connected successfully.");
      log("Player:", PLAYER_NAME);
      log("Version: 3.0");
      log("User:", userId);

      if (isLocallyPlaying()) {
        registerPlaying();
      }

    } catch (error) {
      console.error(
        "[Kulzzy Universal Media] Controller setup failed:",
        error
      );
    }
  }

  async function initialize() {
    try {
      await loadFirebase();

      auth.onAuthStateChanged(function (user) {
        if (user) {
          startController(user);
        } else {
          auth.signInAnonymously().catch(function (error) {
            console.error(
              "[Kulzzy Universal Media] Authentication failed:",
              error
            );
          });
        }
      });

    } catch (error) {
      console.error(
        "[Kulzzy Universal Media] Initialization failed:",
        error
      );
    }
  }

  document.addEventListener("play", handleMediaEvent, true);
  document.addEventListener("playing", handleMediaEvent, true);
  document.addEventListener("pause", handleMediaEvent, true);
  document.addEventListener("ended", handleMediaEvent, true);
  document.addEventListener("error", handleMediaEvent, true);

  window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {
    version: "3.0",
    playerId: PLAYER_ID,
    playerName: PLAYER_NAME,

    notifyPlay: notifyPlay,
    notifyStop: notifyStop,
    stop: stopLocalPlayer,

    getStatus: function () {
      return {
        version: "3.0",
        playerId: PLAYER_ID,
        playerName: PLAYER_NAME,
        userId: userId,
        ready: ready,
        registeredPlaying: registeredPlaying,
        locallyPlaying: isLocallyPlaying()
      };
    }
  };

  initialize();

})();
