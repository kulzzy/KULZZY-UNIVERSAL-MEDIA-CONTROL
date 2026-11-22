/* ==========================================
   KULZZY UNIVERSAL MEDIA CONTROLLER
   FIREBASE + SAME-BROWSER PLAYBACK CONTROL
   VERSION 3.2
========================================== */

(function () {
  "use strict";

  if (window.KULZZY_UNIVERSAL_MEDIA_CONTROL) {
    console.warn("[Kulzzy Media] Controller already loaded.");
    return;
  }

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
  const CHANNEL_NAME = "KULZZY_UNIVERSAL_MEDIA_PLAYBACK";
  const PLAYER_CONFIG = window.KULZZY_MEDIA_PLAYER_CONFIG || {};

  const PLAYER_ID = String(
    PLAYER_CONFIG.playerId ||
    location.hostname + location.pathname
  );

  const PLAYER_NAME = String(
    PLAYER_CONFIG.playerName || PLAYER_ID
  );

  const MEDIA_SELECTOR = PLAYER_CONFIG.mediaSelector || "audio,video";

  function makeSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID().replace(/-/g, "");
    }

    return "s" + Date.now().toString(36) +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);
  }

  const SESSION_ID = makeSessionId();

  let mediaChannel = null;

  try {
    if ("BroadcastChannel" in window) {
      mediaChannel = new BroadcastChannel(CHANNEL_NAME);
    }
  } catch (error) {
    console.warn(
      "[Kulzzy Media] Same-browser channel unavailable; Firebase remains active.",
      error
    );
  }

  let firebaseApp = null;
  let auth = null;
  let database = null;
  let sessionRef = null;
  let playersRef = null;
  let userId = null;

  let ready = false;
  let registeredPlaying = false;
  let stoppingByController = false;
  let stopResetTimer = null;
  let stopCheckTimer = null;
  let monitorAttached = false;

  function log() {
    console.log("[Kulzzy Universal Media]", ...arguments);
  }

  const scriptLoads = Object.create(null);

  function loadScript(url) {
    if (scriptLoads[url]) return scriptLoads[url];

    scriptLoads[url] = new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;

      script.onload = resolve;

      script.onerror = function () {
        delete scriptLoads[url];
        reject(new Error("Could not load Firebase SDK: " + url));
      };

      document.head.appendChild(script);
    });

    return scriptLoads[url];
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
        "[Kulzzy Media] Invalid mediaSelector:",
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

  function announcePlayback() {
    if (!mediaChannel) return;

    try {
      mediaChannel.postMessage({
        type: "KULZZY_MEDIA_PLAY",
        playerId: PLAYER_ID,
        playerName: PLAYER_NAME,
        sessionId: SESSION_ID,
        sentAt: Date.now()
      });
    } catch (error) {
      console.warn(
        "[Kulzzy Media] Could not send same-browser playback notice:",
        error
      );
    }
  }

  function removeOwnRegistration() {
    if (!sessionRef || !registeredPlaying) {
      return Promise.resolve();
    }

    registeredPlaying = false;

    return sessionRef.remove().catch(function (error) {
      console.error(
        "[Kulzzy Media] Could not remove session:",
        error
      );
    });
  }

  function registerPlaying() {
    if (
      !ready ||
      !sessionRef ||
      stoppingByController ||
      registeredPlaying
    ) {
      return;
    }

    registeredPlaying = true;

    sessionRef.set({
      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,
      sessionId: SESSION_ID,
      playing: true,
      startedAt: firebase.database.ServerValue.TIMESTAMP
    }).catch(function (error) {
      registeredPlaying = false;

      console.error(
        "[Kulzzy Media] Could not register playback:",
        error
      );
    });

    log(
      "Playback started:",
      PLAYER_NAME,
      "Session:",
      SESSION_ID
    );
  }

  function notifyPlay() {
    clearTimeout(stopCheckTimer);

    announcePlayback();
    registerPlaying();
  }

  function notifyStop(force) {
    clearTimeout(stopCheckTimer);

    if (!force && isLocallyPlaying()) return;
    if (!registeredPlaying) return;

    removeOwnRegistration();

    log("Playback stopped:", PLAYER_NAME);
  }

  function stopLocalPlayer(reason) {
    if (stoppingByController) return;

    stoppingByController = true;

    clearTimeout(stopResetTimer);
    clearTimeout(stopCheckTimer);

    const detail = {
      reason: reason || "another-player-started",
      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,
      controller: "KULZZY_UNIVERSAL_MEDIA_CONTROL",
      version: "3.2"
    };

    log(
      "Another player has taken control. Stopping:",
      PLAYER_NAME,
      "Reason:",
      detail.reason
    );

    window.dispatchEvent(
      new CustomEvent("kulzzy:media-stop", {
        detail: detail
      })
    );

    window.postMessage({
      type: "KULZZY_UNIVERSAL_MEDIA_STOP",
      detail: detail
    }, "*");

    if (typeof PLAYER_CONFIG.stop === "function") {
      try {
        PLAYER_CONFIG.stop(detail);
      } catch (error) {
        console.error(
          "[Kulzzy Media] Custom stop function failed:",
          error
        );
      }
    }

    getMediaElements().forEach(function (media) {
      try {
        media.pause();
      } catch (error) {
        console.error(
          "[Kulzzy Media] Media pause failed:",
          error
        );
      }
    });

    removeOwnRegistration();

    stopResetTimer = setTimeout(function () {
      stoppingByController = false;
    }, 1000);
  }

  function handleChannelMessage(event) {
    const message = event && event.data;

    if (!message || message.type !== "KULZZY_MEDIA_PLAY") {
      return;
    }

    if (
      message.sessionId === SESSION_ID &&
      message.playerId === PLAYER_ID
    ) {
      return;
    }

    if (!message.sessionId || !message.playerId) {
      return;
    }

    if (isLocallyPlaying() || registeredPlaying) {
      stopLocalPlayer(
        "Playback taken by " +
        String(message.playerName || message.playerId)
      );
    }
  }

  if (mediaChannel) {
    mediaChannel.addEventListener("message", handleChannelMessage);
  }

  function getWinningSession(snapshot) {
    const active = [];

    snapshot.forEach(function (uidNode) {
      uidNode.forEach(function (sessionNode) {
        const data = sessionNode.val();

        if (!data || data.playing !== true) return;

        active.push({
          uid: uidNode.key,
          playerId: data.playerId || sessionNode.key,
          playerName:
            data.playerName ||
            data.playerId ||
            "Kulzzy Player",
          sessionId: data.sessionId || sessionNode.key,
          startedAt: Number(data.startedAt) || 0
        });
      });
    });

    active.sort(function (a, b) {
      if (a.startedAt !== b.startedAt) {
        return b.startedAt - a.startedAt;
      }

      return String(b.sessionId).localeCompare(
        String(a.sessionId)
      );
    });

    return active.length ? active[0] : null;
  }

  function monitorPlayers() {
    if (monitorAttached || !playersRef) return;

    monitorAttached = true;

    playersRef.on("value", function (snapshot) {
      const winner = getWinningSession(snapshot);

      if (!winner) {
        log("No active player.");
        return;
      }

      if (
        winner.uid !== userId ||
        winner.sessionId !== SESSION_ID
      ) {
        if (isLocallyPlaying() || registeredPlaying) {
          stopLocalPlayer(
            "Playback taken by " + winner.playerName
          );
        }
      } else {
        log(
          "This session has control:",
          PLAYER_NAME
        );
      }
    }, function (error) {
      console.error(
        "[Kulzzy Media] Player monitor failed:",
        error
      );
    });
  }

  function handleMediaEvent(event) {
    if (stoppingByController) return;

    const target = event.target;

    if (
      !target ||
      typeof target.matches !== "function"
    ) {
      return;
    }

    let matches = false;

    try {
      matches = target.matches(MEDIA_SELECTOR);
    } catch (error) {
      return;
    }

    if (!matches) return;

    if (
      event.type === "play" ||
      event.type === "playing"
    ) {
      notifyPlay();
      return;
    }

    if (
      event.type === "pause" ||
      event.type === "ended" ||
      event.type === "error"
    ) {
      clearTimeout(stopCheckTimer);

      stopCheckTimer = setTimeout(function () {
        if (!isLocallyPlaying()) {
          notifyStop(true);
        }
      }, 200);
    }
  }

  async function startController(user) {
    if (ready || !user) return;

    userId = user.uid;

    sessionRef = database.ref(
      "control/players/" +
      userId +
      "/" +
      SESSION_ID
    );

    playersRef = database.ref("control/players");

    try {
      await sessionRef.onDisconnect().remove();

      ready = true;

      monitorPlayers();

      log("Connected to Firebase.");
      log("Controller version: 3.2");
      log(
        "Same-browser channel:",
        mediaChannel ? "available" : "unavailable"
      );
      log("Player:", PLAYER_NAME);
      log("Firebase user:", userId);
      log("Unique session:", SESSION_ID);

      if (isLocallyPlaying()) {
        announcePlayback();
        registerPlaying();
      }

    } catch (error) {
      console.error(
        "[Kulzzy Media] Session setup failed:",
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
              "[Kulzzy Media] Anonymous sign-in failed:",
              error
            );
          });
        }
      });

    } catch (error) {
      console.error(
        "[Kulzzy Media] Initialization failed:",
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
    version: "3.2",
    playerId: PLAYER_ID,
    playerName: PLAYER_NAME,
    sessionId: SESSION_ID,

    notifyPlay: notifyPlay,
    notifyStop: notifyStop,
    stop: stopLocalPlayer,

    getStatus: function () {
      return {
        version: "3.2",
        playerId: PLAYER_ID,
        playerName: PLAYER_NAME,
        sessionId: SESSION_ID,
        userId: userId,
        ready: ready,
        registeredPlaying: registeredPlaying,
        locallyPlaying: isLocallyPlaying(),
        sameBrowserChannel: !!mediaChannel
      };
    }
  };

  initialize();

})();
