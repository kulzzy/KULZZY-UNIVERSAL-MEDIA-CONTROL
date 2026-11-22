/* =====================================================
   KULZZY UNIVERSAL MEDIA CONTROL
   VERSION 4.0
   Cross-device playback coordination
   Heartbeat and stale-session protection
===================================================== */

(function () {
  "use strict";

  if (window.KULZZY_UNIVERSAL_MEDIA_CONTROL) {
    return;
  }

  const VERSION = "4.0";

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

  const HEARTBEAT_INTERVAL = 15000;
  const SESSION_TIMEOUT = 60000;

  const PLAYER_CONFIG =
    window.KULZZY_MEDIA_PLAYER_CONFIG || {};

  const PLAYER_ID = String(
    PLAYER_CONFIG.playerId ||
    location.hostname + location.pathname
  );

  const PLAYER_NAME = String(
    PLAYER_CONFIG.playerName || PLAYER_ID
  );

  const MEDIA_SELECTOR =
    PLAYER_CONFIG.mediaSelector || "audio,video";

  function createId() {
    if (
      window.crypto &&
      typeof window.crypto.randomUUID === "function"
    ) {
      return window.crypto.randomUUID().replace(/-/g, "");
    }

    return "s" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2);
  }

  const SESSION_ID = createId();

  let firebaseApp = null;
  let auth = null;
  let database = null;

  let userId = null;
  let sessionRef = null;
  let playersRef = null;

  let ready = false;
  let connected = false;

  let wantsPlayback = false;
  let registeredPlaying = false;

  let stoppingByController = false;
  let heartbeatTimer = null;
  let stopResetTimer = null;
  let stopCheckTimer = null;

  let operationQueue = Promise.resolve();
  let startedAt = null;
  let serverTimeOffset = 0;

  let mediaChannel = null;
  let monitorAttached = false;

  const scriptLoads = Object.create(null);

  /* =========================
     SCRIPT LOADER
  ========================= */

  function loadScript(url) {
    if (scriptLoads[url]) {
      return scriptLoads[url];
    }

    scriptLoads[url] = new Promise(function (resolve, reject) {
      const script = document.createElement("script");

      script.src = url;
      script.async = true;

      script.onload = resolve;

      script.onerror = function () {
        delete scriptLoads[url];
        reject(new Error("Could not load Firebase SDK."));
      };

      document.head.appendChild(script);
    });

    return scriptLoads[url];
  }

  /* =========================
     FIREBASE INITIALIZATION
  ========================= */

  async function initializeFirebase() {
    const base =
      "https://www.gstatic.com/firebasejs/" +
      SDK_VERSION + "/";

    await loadScript(base + "firebase-app-compat.js");
    await loadScript(base + "firebase-auth-compat.js");
    await loadScript(base + "firebase-database-compat.js");

    if (!window.firebase) {
      throw new Error("Firebase SDK unavailable.");
    }

    const existing = firebase.apps.find(function (app) {
      return app.name === APP_NAME;
    });

    firebaseApp = existing ||
      firebase.initializeApp(FIREBASE_CONFIG, APP_NAME);

    auth = firebaseApp.auth();
    database = firebaseApp.database();

    const offsetRef = database.ref(".info/serverTimeOffset");

    offsetRef.on("value", function (snapshot) {
      serverTimeOffset = Number(snapshot.val()) || 0;
    });
  }

  /* =========================
     MEDIA HELPERS
  ========================= */

  function getMediaElements() {
    try {
      return Array.from(
        document.querySelectorAll(MEDIA_SELECTOR)
      );
    } catch (error) {
      console.error("[Kulzzy Media] Invalid media selector.", error);
      return [];
    }
  }

  function isLocallyPlaying() {
    return getMediaElements().some(function (media) {
      return !media.paused && !media.ended;
    });
  }

  /* =========================
     SAME-BROWSER CONTROL
  ========================= */

  try {
    if ("BroadcastChannel" in window) {
      mediaChannel = new BroadcastChannel(CHANNEL_NAME);
    }
  } catch (error) {
    console.warn("[Kulzzy Media] BroadcastChannel unavailable.");
  }

  function broadcastPlay() {
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
      console.warn("[Kulzzy Media] Broadcast failed.", error);
    }
  }

  /* =========================
     SERIALIZED FIREBASE WORK
  ========================= */

  function queueOperation(operation) {
    operationQueue = operationQueue
      .then(operation)
      .catch(function (error) {
        console.error("[Kulzzy Media] Firebase operation failed.", error);
      });

    return operationQueue;
  }

  function removeRegistration() {
    return queueOperation(async function () {
      if (!sessionRef) {
        registeredPlaying = false;
        return;
      }

      await sessionRef.remove();

      registeredPlaying = false;
      startedAt = null;
    });
  }

  function registerPlayback() {
    return queueOperation(async function () {
      if (
        !ready ||
        !connected ||
        !sessionRef ||
        !wantsPlayback ||
        stoppingByController
      ) {
        return;
      }

      const currentTime = Date.now() + serverTimeOffset;

      if (!startedAt) {
        startedAt = firebase.database.ServerValue.TIMESTAMP;
      }

      await sessionRef.set({
        playerId: PLAYER_ID,
        playerName: PLAYER_NAME,
        sessionId: SESSION_ID,
        playing: true,
        startedAt: startedAt,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });

      registeredPlaying = true;

      /*
       * A stop may have occurred while Firebase
       * was processing the registration.
       * The next queued operation removes it.
       */

      if (!wantsPlayback || stoppingByController) {
        await sessionRef.remove();

        registeredPlaying = false;
        startedAt = null;

        return;
      }

      console.log(
        "[Kulzzy Media] Playback registered:",
        PLAYER_NAME
      );
    });
  }

  function heartbeat() {
    if (
      !ready ||
      !connected ||
      !wantsPlayback ||
      !registeredPlaying ||
      !sessionRef
    ) {
      return;
    }

    queueOperation(async function () {
      if (
        !wantsPlayback ||
        stoppingByController ||
        !connected
      ) {
        return;
      }

      await sessionRef.update({
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });
    });
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);

    heartbeatTimer = setInterval(
      heartbeat,
      HEARTBEAT_INTERVAL
    );
  }

  /* =========================
     PLAY / STOP NOTIFICATIONS
  ========================= */

  function notifyPlay() {
    if (stoppingByController) return;

    wantsPlayback = true;

    broadcastPlay();

    if (ready && connected) {
      registerPlayback();
    }
  }

  function notifyStop(force) {
    clearTimeout(stopCheckTimer);

    if (!force && isLocallyPlaying()) {
      return;
    }

    wantsPlayback = false;

    removeRegistration();
  }

  /* =========================
     STOP LOCAL PLAYER
  ========================= */

  function stopLocalPlayer(reason) {
    if (stoppingByController) return;

    stoppingByController = true;
    wantsPlayback = false;

    clearTimeout(stopCheckTimer);
    clearInterval(heartbeatTimer);

    const detail = {
      reason: reason || "another-player-started",
      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,
      sessionId: SESSION_ID,
      controller: "KULZZY_UNIVERSAL_MEDIA_CONTROL",
      version: VERSION
    };

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
          "[Kulzzy Media] Custom stop failed.",
          error
        );
      }
    }

    getMediaElements().forEach(function (media) {
      try {
        media.pause();
      } catch (error) {
        console.warn("[Kulzzy Media] Could not pause media.", error);
      }
    });

    removeRegistration();

    clearTimeout(stopResetTimer);

    stopResetTimer = setTimeout(function () {
      stoppingByController = false;
    }, 1200);
  }

  /* =========================
     SESSION FRESHNESS
  ========================= */

  function getWinningSession(snapshot) {
    const now = Date.now() + serverTimeOffset;
    const active = [];

    snapshot.forEach(function (uidNode) {
      uidNode.forEach(function (sessionNode) {
        const data = sessionNode.val();

        if (!data || data.playing !== true) {
          return;
        }

        const lastSeen = Number(data.lastSeen) || 0;

        /*
         * Ignore old sessions that have stopped
         * sending heartbeat updates.
         */

        if (
          !lastSeen ||
          now - lastSeen > SESSION_TIMEOUT ||
          lastSeen - now > 30000
        ) {
          return;
        }

        active.push({
          uid: uidNode.key,
          playerId: data.playerId || sessionNode.key,
          playerName:
            data.playerName ||
            data.playerId ||
            "Kulzzy Player",
          sessionId: data.sessionId || sessionNode.key,
          startedAt: Number(data.startedAt) || 0,
          lastSeen: lastSeen
        });
      });
    });

    active.sort(function (a, b) {
      if (a.startedAt !== b.startedAt) {
        return b.startedAt - a.startedAt;
      }

      return b.lastSeen - a.lastSeen;
    });

    return active.length ? active[0] : null;
  }

  /* =========================
     CROSS-DEVICE MONITOR
  ========================= */

  function monitorPlayers() {
    if (monitorAttached || !playersRef) {
      return;
    }

    monitorAttached = true;

    playersRef.on("value", function (snapshot) {
      const winner = getWinningSession(snapshot);

      if (!winner) {
        return;
      }

      const isOwnSession =
        winner.uid === userId &&
        winner.sessionId === SESSION_ID;

      if (!isOwnSession) {
        if (isLocallyPlaying() || wantsPlayback) {
          stopLocalPlayer(
            "Playback taken by " + winner.playerName
          );
        }
      }
    }, function (error) {
      console.error(
        "[Kulzzy Media] Player monitoring failed.",
        error
      );
    });
  }

  /* =========================
     BROWSER TAB MESSAGES
  ========================= */

  function handleChannelMessage(event) {
    const message = event && event.data;

    if (
      !message ||
      message.type !== "KULZZY_MEDIA_PLAY"
    ) {
      return;
    }

    if (message.sessionId === SESSION_ID) {
      return;
    }

    if (!message.playerId) {
      return;
    }

    if (isLocallyPlaying() || wantsPlayback) {
      stopLocalPlayer(
        "Playback taken by " +
        String(message.playerName || message.playerId)
      );
    }
  }

  if (mediaChannel) {
    mediaChannel.addEventListener(
      "message",
      handleChannelMessage
    );
  }

  /* =========================
     MEDIA EVENT MONITOR
  ========================= */

  function handleMediaEvent(event) {
    if (stoppingByController) {
      return;
    }

    const media = event.target;

    if (
      !media ||
      typeof media.matches !== "function"
    ) {
      return;
    }

    let matches = false;

    try {
      matches = media.matches(MEDIA_SELECTOR);
    } catch (error) {
      return;
    }

    if (!matches) {
      return;
    }

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
      }, 300);
    }
  }

  [
    "play",
    "playing",
    "pause",
    "ended",
    "error"
  ].forEach(function (eventName) {
    document.addEventListener(
      eventName,
      handleMediaEvent,
      true
    );
  });

  /* =========================
     FIREBASE CONNECTION
  ========================= */

  async function setupUser(user) {
    if (!user || userId === user.uid) {
      return;
    }

    userId = user.uid;

    sessionRef = database.ref(
      "control/players/" +
      userId +
      "/" +
      SESSION_ID
    );

    playersRef = database.ref("control/players");

    await sessionRef.onDisconnect().remove();

    ready = true;

    monitorPlayers();

    console.log(
      "[Kulzzy Media] Connected:",
      PLAYER_NAME
    );

    if (isLocallyPlaying()) {
      wantsPlayback = true;
      registerPlayback();
    }
  }

  function monitorConnection() {
    database.ref(".info/connected").on(
      "value",
      async function (snapshot) {
        connected = snapshot.val() === true;

        if (!connected) {
          registeredPlaying = false;
          return;
        }

        console.log("[Kulzzy Media] Firebase connected.");

        if (sessionRef) {
          try {
            await sessionRef.onDisconnect().remove();
          } catch (error) {
            console.error(
              "[Kulzzy Media] Reconnection setup failed.",
              error
            );
          }
        }

        if (wantsPlayback && !stoppingByController) {
          registerPlayback();
        }
      }
    );
  }

  /* =========================
     AUTHENTICATION
  ========================= */

  async function initialize() {
    try {
      await initializeFirebase();

      monitorConnection();

      auth.onAuthStateChanged(
        async function (user) {
          try {
            if (user) {
              await setupUser(user);
            } else {
              await auth.signInAnonymously();
            }
          } catch (error) {
            console.error(
              "[Kulzzy Media] Authentication setup failed.",
              error
            );
          }
        },
        function (error) {
          console.error(
            "[Kulzzy Media] Authentication failed.",
            error
          );
        }
      );

    } catch (error) {
      console.error(
        "[Kulzzy Media] Controller initialization failed.",
        error
      );
    }
  }

  /* =========================
     PAGE CLEANUP
  ========================= */

  function cleanup() {
    wantsPlayback = false;

    clearInterval(heartbeatTimer);
    clearTimeout(stopCheckTimer);

    if (sessionRef) {
      sessionRef.remove().catch(function () {});
    }

    if (mediaChannel) {
      try {
        mediaChannel.close();
      } catch (error) {}
    }
  }

  window.addEventListener("pagehide", cleanup);

  /* =========================
     PUBLIC CONTROLLER API
  ========================= */

  window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {
    version: VERSION,

    playerId: PLAYER_ID,
    playerName: PLAYER_NAME,
    sessionId: SESSION_ID,

    notifyPlay: notifyPlay,
    notifyStop: notifyStop,
    stop: stopLocalPlayer,

    getStatus: function () {
      return {
        version: VERSION,
        playerId: PLAYER_ID,
        playerName: PLAYER_NAME,
        sessionId: SESSION_ID,
        userId: userId,
        ready: ready,
        connected: connected,
        registeredPlaying: registeredPlaying,
        locallyPlaying: isLocallyPlaying(),
        sameBrowserChannel: !!mediaChannel
      };
    }
  };

  initialize();

})();
