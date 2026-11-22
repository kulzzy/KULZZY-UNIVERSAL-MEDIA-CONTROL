/* ==========================================
   KULZZY UNIVERSAL MEDIA CONTROLLER
   TEMPORARY FIREBASE DIAGNOSTICS
   VERSION 3.3
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

  let diagnosticPanel;
  let diagnosticContent;

  function diagnostic(message, error) {
    const time = new Date().toLocaleTimeString();

    let detail = "";

    if (error) {
      detail =
        "\nCode: " + (error.code || "Not provided") +
        "\nMessage: " + (error.message || String(error));
    }

    const entry = "[" + time + "] " + message + detail;

    console.log("[Kulzzy Diagnostic]", entry);

    if (diagnosticContent) {
      const line = document.createElement("div");
      line.textContent = entry;
      line.style.cssText =
        "padding:7px 0;border-bottom:1px solid #46516b;" +
        "white-space:pre-wrap;overflow-wrap:anywhere;";

      diagnosticContent.prepend(line);
    }
  }

  function createDiagnosticPanel() {
    if (diagnosticPanel) return;

    diagnosticPanel = document.createElement("div");

    diagnosticPanel.id = "kulzzy-firebase-diagnostics";

    diagnosticPanel.style.cssText = [
      "position:fixed",
      "top:8px",
      "left:8px",
      "right:8px",
      "z-index:2147483647",
      "max-height:34vh",
      "overflow:auto",
      "background:#06122a",
      "color:#ffffff",
      "border:2px solid #ffd700",
      "border-radius:10px",
      "padding:12px",
      "font:12px Arial,sans-serif",
      "box-shadow:0 3px 15px rgba(0,0,0,.5)"
    ].join(";");

    const heading = document.createElement("div");

    heading.textContent =
      "KULZZY RADIO — FIREBASE DIAGNOSTICS";

    heading.style.cssText =
      "color:#ffd700;font-weight:bold;font-size:13px;" +
      "margin-bottom:9px;";

    const status = document.createElement("div");

    status.textContent = "Controller starting...";

    status.style.cssText =
      "padding:7px;background:#152542;border-radius:5px;" +
      "margin-bottom:8px;";

    status.id = "kulzzy-diagnostic-status";

    diagnosticContent = document.createElement("div");

    diagnosticPanel.appendChild(heading);
    diagnosticPanel.appendChild(status);
    diagnosticPanel.appendChild(diagnosticContent);

    document.documentElement.appendChild(diagnosticPanel);

    diagnostic("Diagnostic panel started.");
  }

  function setStatus(message) {
    const element =
      document.getElementById("kulzzy-diagnostic-status");

    if (element) {
      element.textContent = message;
    }

    diagnostic(message);
  }

  createDiagnosticPanel();

  diagnostic("Controller version 3.3 loaded.");
  diagnostic("Player: " + PLAYER_NAME);
  diagnostic("Player ID: " + PLAYER_ID);
  diagnostic("Page: " + location.href);

  function makeSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID().replace(/-/g, "");
    }

    return "s" + Date.now().toString(36) +
      Math.random().toString(36).slice(2);
  }

  const SESSION_ID = makeSessionId();

  let mediaChannel = null;

  try {
    if ("BroadcastChannel" in window) {
      mediaChannel = new BroadcastChannel(CHANNEL_NAME);
    }
  } catch (error) {
    diagnostic("BroadcastChannel unavailable.", error);
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

  const scriptLoads = Object.create(null);

  function loadScript(url) {
    if (scriptLoads[url]) return scriptLoads[url];

    return scriptLoads[url] = new Promise(function (resolve, reject) {
      const script = document.createElement("script");

      script.src = url;
      script.async = true;

      script.onload = function () {
        diagnostic("Loaded: " + url);
        resolve();
      };

      script.onerror = function () {
        delete scriptLoads[url];

        const error = new Error(
          "Could not load script: " + url
        );

        diagnostic("SCRIPT LOADING FAILED.", error);
        reject(error);
      };

      document.head.appendChild(script);
    });
  }

  async function loadFirebase() {
    setStatus("Loading Firebase SDK...");

    const base =
      "https://www.gstatic.com/firebasejs/" +
      SDK_VERSION + "/";

    await loadScript(base + "firebase-app-compat.js");
    await loadScript(base + "firebase-auth-compat.js");
    await loadScript(base + "firebase-database-compat.js");

    if (!window.firebase) {
      throw new Error("Firebase SDK is not available.");
    }

    diagnostic("All Firebase SDK files loaded.");

    const existing = firebase.apps.find(function (app) {
      return app.name === APP_NAME;
    });

    firebaseApp = existing ||
      firebase.initializeApp(FIREBASE_CONFIG, APP_NAME);

    auth = firebaseApp.auth();
    database = firebaseApp.database();

    diagnostic("Firebase app initialized.");
    diagnostic("Project: " + FIREBASE_CONFIG.projectId);
    diagnostic("Database: " + FIREBASE_CONFIG.databaseURL);
  }

  function getMediaElements() {
    try {
      return Array.from(
        document.querySelectorAll(MEDIA_SELECTOR)
      );
    } catch (error) {
      diagnostic("Invalid media selector.", error);
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
      diagnostic("BroadcastChannel message failed.", error);
    }
  }

  function removeOwnRegistration() {
    if (!sessionRef || !registeredPlaying) {
      return Promise.resolve();
    }

    registeredPlaying = false;

    return sessionRef.remove().catch(function (error) {
      diagnostic("Could not remove playback registration.", error);
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

    diagnostic("Attempting to register playback in Firebase...");

    sessionRef.set({
      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,
      sessionId: SESSION_ID,
      playing: true,
      startedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(function () {
      diagnostic("SUCCESS: Playback registered in Firebase.");
    }).catch(function (error) {
      registeredPlaying = false;

      diagnostic("PLAYBACK REGISTRATION FAILED.", error);
    });

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

    diagnostic("Playback stopped: " + PLAYER_NAME);
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
      version: "3.3"
    };

    diagnostic(
      "Another player took control. Stopping " + PLAYER_NAME
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
        diagnostic("Custom stop function failed.", error);
      }
    }

    getMediaElements().forEach(function (media) {
      try {
        media.pause();
      } catch (error) {
        diagnostic("Media pause failed.", error);
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
    diagnostic("Same-browser playback channel available.");
  } else {
    diagnostic("Same-browser playback channel unavailable.");
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

    diagnostic("Starting Firebase player monitor...");

    playersRef.on("value", function (snapshot) {
      diagnostic("Firebase player monitor received an update.");

      const winner = getWinningSession(snapshot);

      if (!winner) {
        diagnostic("No active player registered.");
        return;
      }

      diagnostic("Active player: " + winner.playerName);

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
        diagnostic("This player currently has control.");
      }

    }, function (error) {
      diagnostic("FIREBASE PLAYER MONITOR FAILED.", error);
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
      diagnostic("Media event detected: " + event.type);
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

    diagnostic("Anonymous authentication successful.");
    diagnostic("Firebase UID: " + userId);

    sessionRef = database.ref(
      "control/players/" +
      userId +
      "/" +
      SESSION_ID
    );

    playersRef = database.ref("control/players");

    try {
      diagnostic("Setting up automatic session cleanup...");

      await sessionRef.onDisconnect().remove();

      diagnostic("Automatic session cleanup configured.");

      ready = true;

      monitorPlayers();

      setStatus("CONNECTED — Firebase authentication successful.");

      diagnostic("Controller is ready.");
      diagnostic("Player: " + PLAYER_NAME);
      diagnostic("Session: " + SESSION_ID);

      database.ref(".info/connected").on("value", function (snapshot) {
        diagnostic(
          "Database connection: " +
          (snapshot.val() === true ? "CONNECTED" : "DISCONNECTED")
        );
      });

      if (isLocallyPlaying()) {
        announcePlayback();
        registerPlaying();
      }

    } catch (error) {
      setStatus("FIREBASE SESSION SETUP FAILED.");
      diagnostic("Session setup failed.", error);
    }
  }

  async function initialize() {
    try {
      await loadFirebase();

      setStatus("Firebase loaded. Checking authentication...");

      auth.onAuthStateChanged(function (user) {
        if (user) {
          startController(user);
        } else {
          diagnostic("No authenticated user detected.");
          setStatus("Signing in anonymously...");

          auth.signInAnonymously().then(function (result) {
            diagnostic("Anonymous sign-in request completed.");

            if (result && result.user) {
              diagnostic("Anonymous account created.");
            }

          }).catch(function (error) {
            setStatus("ANONYMOUS SIGN-IN FAILED.");
            diagnostic("ANONYMOUS SIGN-IN FAILED.", error);
          });
        }

      }, function (error) {
        setStatus("AUTHENTICATION LISTENER FAILED.");
        diagnostic("Authentication listener error.", error);
      });

    } catch (error) {
      setStatus("CONTROLLER INITIALIZATION FAILED.");
      diagnostic("Initialization failed.", error);
    }
  }

  document.addEventListener("play", handleMediaEvent, true);
  document.addEventListener("playing", handleMediaEvent, true);
  document.addEventListener("pause", handleMediaEvent, true);
  document.addEventListener("ended", handleMediaEvent, true);
  document.addEventListener("error", handleMediaEvent, true);

  window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {
    version: "3.3",
    playerId: PLAYER_ID,
    playerName: PLAYER_NAME,
    sessionId: SESSION_ID,
    notifyPlay: notifyPlay,
    notifyStop: notifyStop,
    stop: stopLocalPlayer,

    getStatus: function () {
      return {
        version: "3.3",
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
