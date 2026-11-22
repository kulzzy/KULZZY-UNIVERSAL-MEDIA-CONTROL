/* =====================================================
   KULZZY UNIVERSAL MEDIA CONTROL
   CENTRAL CROSS-DEVICE PLAYBACK AUTHORITY
   One Kulzzy player at a time
===================================================== */

(function () {
"use strict";

if (window.KULZZY_UNIVERSAL_MEDIA_CONTROL) return;

/* FIREBASE CONFIGURATION */

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

const HEARTBEAT = 10000;
const STALE_AFTER = 35000;

const CONFIG = window.KULZZY_MEDIA_PLAYER_CONFIG || {};

const PLAYER_ID = String(
  CONFIG.playerId || location.hostname + location.pathname
);

const PLAYER_NAME = String(
  CONFIG.playerName || PLAYER_ID
);

const MEDIA_SELECTOR = CONFIG.mediaSelector || "audio,video";

const SESSION_ID =
  window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) +
      Math.random().toString(36).slice(2);

let app;
let auth;
let db;
let activeRef;

let userId = null;

let ready = false;
let connected = false;
let wantsPlayback = false;
let registered = false;
let stopping = false;
let claimRunning = false;
let claimAgain = false;

let heartbeatTimer = null;
let pauseTimer = null;
let resetTimer = null;

let serverOffset = 0;
let lastError = "";

/* LOGGING */

function log() {
  console.log(
    "[KULZZY UNIVERSAL CONTROL]",
    ...arguments
  );
}

function reportError(label, error) {
  lastError =
    label + ": " +
    (error && error.message ? error.message : String(error));

  console.error(
    "[KULZZY UNIVERSAL CONTROL]",
    lastError,
    error || ""
  );
}

/* LOAD FIREBASE SDK */

function loadScript(url) {

  return new Promise(function(resolve, reject) {

    const existing = document.querySelector(
      'script[data-kulzzy-sdk="' + url + '"]'
    );

    if (existing) {

      if (existing.dataset.loaded === "yes") {
        resolve();
        return;
      }

      existing.addEventListener("load", resolve, {
        once: true
      });

      existing.addEventListener("error", reject, {
        once: true
      });

      return;
    }

    const script = document.createElement("script");

    script.src = url;
    script.async = true;
    script.dataset.kulzzySdk = url;

    script.onload = function() {
      script.dataset.loaded = "yes";
      resolve();
    };

    script.onerror = function() {
      reject(
        new Error("Firebase SDK could not load: " + url)
      );
    };

    document.head.appendChild(script);

  });

}

/* INITIALIZE FIREBASE */

async function initializeFirebase() {

  const base =
    "https://www.gstatic.com/firebasejs/" +
    SDK_VERSION + "/";

  await loadScript(base + "firebase-app-compat.js");
  await loadScript(base + "firebase-auth-compat.js");
  await loadScript(base + "firebase-database-compat.js");

  const existing = firebase.apps.find(function(item) {
    return item.name === APP_NAME;
  });

  app = existing || firebase.initializeApp(
    FIREBASE_CONFIG,
    APP_NAME
  );

  auth = app.auth();
  db = app.database();

  activeRef = db.ref("control/activePlayback");

  db.ref(".info/serverTimeOffset").on(
    "value",
    function(snapshot) {
      serverOffset = Number(snapshot.val()) || 0;
    }
  );

}

function serverNow() {
  return Date.now() + serverOffset;
}

/* FIND MEDIA */

function getMedia() {

  try {

    return Array.from(
      document.querySelectorAll(MEDIA_SELECTOR)
    );

  } catch(error) {

    reportError("Media selector error", error);

    return [];

  }

}

function pageIsPlaying() {

  return getMedia().some(function(media) {

    return !media.paused && !media.ended;

  });

}

/* HEARTBEAT */

function stopHeartbeat() {

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  heartbeatTimer = null;

}

function startHeartbeat() {

  stopHeartbeat();

  if (!registered || !wantsPlayback) return;

  heartbeatTimer = setInterval(function() {

    if (
      !ready ||
      !connected ||
      !registered ||
      !wantsPlayback ||
      stopping
    ) return;

    activeRef.transaction(

      function(current) {

        if (
          !current ||
          current.uid !== userId ||
          current.sessionId !== SESSION_ID
        ) {
          return;
        }

        current.lastSeen = serverNow();
        current.playing = true;

        return current;

      },

      function(error, committed, snapshot) {

        if (error) {

          reportError(
            "Heartbeat failed",
            error
          );

          return;
        }

        const owner = snapshot && snapshot.val();

        if (
          !committed ||
          !owner ||
          owner.sessionId !== SESSION_ID
        ) {

          stopLocalPlayer(
            "Another Kulzzy player has taken playback."
          );

        }

      },

      false

    );

  }, HEARTBEAT);

}

/* RELEASE PLAYBACK OWNERSHIP */

function releaseOwnership() {

  stopHeartbeat();

  registered = false;

  if (!activeRef || !userId) {
    return Promise.resolve();
  }

  return activeRef.transaction(

    function(current) {

      if (
        current &&
        current.uid === userId &&
        current.sessionId === SESSION_ID
      ) {
        return null;
      }

      return;

    },

    function(error) {

      if (error) {
        reportError(
          "Could not release playback ownership",
          error
        );
      }

    },

    false

  );

}

/* CLAIM PLAYBACK */

function claimPlayback() {

  if (
    !ready ||
    !connected ||
    !wantsPlayback ||
    stopping
  ) return;

  if (claimRunning) {
    claimAgain = true;
    return;
  }

  claimRunning = true;

  const timestamp = serverNow();

  activeRef.transaction(

    function() {

      return {

        uid: userId,

        sessionId: SESSION_ID,

        playerId: PLAYER_ID,

        playerName: PLAYER_NAME,

        playing: true,

        startedAt: timestamp,

        lastSeen: timestamp

      };

    },

    function(error, committed, snapshot) {

      claimRunning = false;

      if (error) {

        reportError(
          "Playback ownership failed. Check Firebase rules.",
          error
        );

      } else {

        const owner = snapshot && snapshot.val();

        if (
          committed &&
          owner &&
          owner.uid === userId &&
          owner.sessionId === SESSION_ID
        ) {

          registered = true;
          lastError = "";

          startHeartbeat();

          log(
            "PLAYBACK OWNERSHIP ACQUIRED:",
            PLAYER_NAME
          );

        } else if (wantsPlayback) {

          stopLocalPlayer(
            "Another Kulzzy player owns playback."
          );

        }

      }

      if (claimAgain) {

        claimAgain = false;

        if (wantsPlayback && !stopping) {
          claimPlayback();
        }

      }

    },

    false

  );

}

/* PLAYER START REQUEST */

function requestPlay() {

  if (stopping) return;

  wantsPlayback = true;

  if (ready && connected) {
    claimPlayback();
  }

}

/* PLAYER STOP REQUEST */

function requestStop() {

  clearTimeout(pauseTimer);

  pauseTimer = setTimeout(function() {

    if (pageIsPlaying()) return;

    wantsPlayback = false;

    releaseOwnership();

  }, 400);

}

/* STOP THIS PLAYER */

function stopLocalPlayer(reason) {

  if (stopping) return;

  stopping = true;

  wantsPlayback = false;
  registered = false;

  stopHeartbeat();

  clearTimeout(pauseTimer);

  const detail = {

    reason:
      reason || "Another Kulzzy player started.",

    playerId: PLAYER_ID,

    playerName: PLAYER_NAME,

    sessionId: SESSION_ID,

    controller: "KULZZY_UNIVERSAL_MEDIA_CONTROL"

  };

  log("STOP COMMAND RECEIVED:", detail.reason);

  /* BROADCAST STOP EVENT */

  try {

    window.dispatchEvent(
      new CustomEvent(
        "kulzzy:media-stop",
        { detail: detail }
      )
    );

  } catch(error) {}

  /* MESSAGE EVENT */

  try {

    window.postMessage({

      type: "KULZZY_UNIVERSAL_MEDIA_STOP",

      detail: detail

    }, "*");

  } catch(error) {}

  /* EXISTING PLAYER STOP FUNCTION */

  if (typeof window.KULZZY_STOP_PLAYER === "function") {

    try {

      window.KULZZY_STOP_PLAYER(detail);

    } catch(error) {

      reportError(
        "Player-specific stop failed",
        error
      );

    }

  }

  /* OPTIONAL CONNECTOR CALLBACK */

  if (typeof CONFIG.stop === "function") {

    try {

      CONFIG.stop(detail);

    } catch(error) {

      reportError(
        "Connector stop callback failed",
        error
      );

    }

  }

  /* STOP ALL HTML MEDIA */

  getMedia().forEach(function(media) {

    try {
      media.pause();
    } catch(error) {}

  });

  releaseOwnership();

  clearTimeout(resetTimer);

  resetTimer = setTimeout(function() {

    stopping = false;

  }, 1200);

}

/* WATCH CENTRAL PLAYBACK RECORD */

function watchSharedPlayback() {

  activeRef.on(

    "value",

    function(snapshot) {

      if (!ready) return;

      const owner = snapshot.val();

      if (!owner || owner.playing !== true) return;

      const lastSeen = Number(owner.lastSeen) || 0;

      if (
        !lastSeen ||
        serverNow() - lastSeen > STALE_AFTER
      ) return;

      const isThisSession =
        owner.uid === userId &&
        owner.sessionId === SESSION_ID;

      if (isThisSession) return;

      stopLocalPlayer(
        "Playback was taken by " +
        (owner.playerName || owner.playerId || "another Kulzzy player") +
        "."
      );

    },

    function(error) {

      reportError(
        "Cannot receive playback commands. Check Firebase read rules.",
        error
      );

    }

  );

}

/* CONNECTION MONITOR */

function watchConnection() {

  db.ref(".info/connected").on(
    "value",
    function(snapshot) {

      connected = snapshot.val() === true;

      log(
        "FIREBASE:",
        connected ? "CONNECTED" : "DISCONNECTED"
      );

      if (!connected) {

        registered = false;

        stopHeartbeat();

        return;

      }

      if (ready && wantsPlayback && !stopping) {
        claimPlayback();
      }

    }
  );

}

/* AUTOMATIC MEDIA DETECTION */

function attachMediaEvents() {

  ["play", "playing"].forEach(function(eventName) {

    document.addEventListener(
      eventName,

      function(event) {

        const target = event.target;

        if (
          !target ||
          typeof target.matches !== "function"
        ) return;

        try {

          if (target.matches(MEDIA_SELECTOR)) {
            requestPlay();
          }

        } catch(error) {}

      },

      true
    );

  });

  ["pause", "ended", "error"].forEach(function(eventName) {

    document.addEventListener(
      eventName,

      function(event) {

        const target = event.target;

        if (
          !target ||
          typeof target.matches !== "function"
        ) return;

        try {

          if (target.matches(MEDIA_SELECTOR)) {
            requestStop();
          }

        } catch(error) {}

      },

      true
    );

  });

}

/* INITIALIZATION */

async function initialize() {

  try {

    await initializeFirebase();

    watchConnection();

    auth.onAuthStateChanged(async function(user) {

      try {

        if (!user) {

          await auth.signInAnonymously();

          return;

        }

        userId = user.uid;

        ready = true;

        watchSharedPlayback();

        log(
          "CONTROLLER READY:",
          PLAYER_NAME,
          "UID:",
          userId
        );

        if (pageIsPlaying()) {

          wantsPlayback = true;

          if (connected) {
            claimPlayback();
          }

        }

      } catch(error) {

        reportError(
          "Authentication failed. Enable Anonymous Authentication.",
          error
        );

      }

    });

  } catch(error) {

    reportError(
      "Controller initialization failed",
      error
    );

  }

}

/* CLEANUP */

function cleanup() {

  wantsPlayback = false;

  stopHeartbeat();

  clearTimeout(pauseTimer);

  if (activeRef && userId) {

    activeRef.transaction(

      function(current) {

        if (
          current &&
          current.uid === userId &&
          current.sessionId === SESSION_ID
        ) {
          return null;
        }

        return;

      },

      undefined,

      false

    );

  }

}

/* PUBLIC CONTROL API */

window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {

  playerId: PLAYER_ID,

  playerName: PLAYER_NAME,

  sessionId: SESSION_ID,

  notifyPlay: requestPlay,

  notifyStop: requestStop,

  stop: stopLocalPlayer,

  getStatus: function() {

    return {

      playerId: PLAYER_ID,

      playerName: PLAYER_NAME,

      sessionId: SESSION_ID,

      userId: userId,

      ready: ready,

      connected: connected,

      registeredPlaying: registered,

      locallyPlaying: pageIsPlaying(),

      stopping: stopping,

      lastError: lastError

    };

  }

};

window.addEventListener("pagehide", cleanup);

attachMediaEvents();

initialize();

})();
