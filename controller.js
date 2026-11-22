/* =====================================================
   KULZZY UNIVERSAL MEDIA CONTROL
   ONE CENTRAL PLAYBACK CONTROLLER
   CROSS-DEVICE EXCLUSIVE PLAYBACK
===================================================== */

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

const SDK = "10.12.2";
const APP_NAME = "KULZZY_UNIVERSAL_MEDIA_CONTROL";
const CHANNEL = "KULZZY_UNIVERSAL_MEDIA_PLAYBACK";

const HEARTBEAT = 10000;
const TIMEOUT = 35000;

const CONFIG = window.KULZZY_MEDIA_PLAYER_CONFIG || {};

const PLAYER_ID = String(
  CONFIG.playerId || location.hostname + location.pathname
);

const PLAYER_NAME = String(
  CONFIG.playerName || PLAYER_ID
);

const MEDIA_SELECTOR = CONFIG.mediaSelector || "audio,video";

const SESSION_ID = (
  crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now() + Math.random().toString(36).slice(2)
).toString();

let app;
let auth;
let db;
let userId = null;

let activeRef;
let ready = false;
let connected = false;

let wantsPlayback = false;
let registered = false;
let stopping = false;

let heartbeatTimer = null;
let stopCheckTimer = null;
let resetTimer = null;

let serverOffset = 0;
let channel = null;

let queue = Promise.resolve();
let lastClaimTime = 0;

const scripts = {};

/* =========================================
   LOAD FIREBASE
========================================= */

function loadScript(url) {

  if (scripts[url]) return scripts[url];

  scripts[url] = new Promise((resolve, reject) => {

    const script = document.createElement("script");

    script.src = url;
    script.async = true;

    script.onload = resolve;

    script.onerror = () => {
      delete scripts[url];
      reject(new Error("Firebase SDK failed to load."));
    };

    document.head.appendChild(script);

  });

  return scripts[url];
}

async function initializeFirebase() {

  const base =
    "https://www.gstatic.com/firebasejs/" + SDK + "/";

  await loadScript(base + "firebase-app-compat.js");
  await loadScript(base + "firebase-auth-compat.js");
  await loadScript(base + "firebase-database-compat.js");

  const existing = firebase.apps.find(
    app => app.name === APP_NAME
  );

  app = existing || firebase.initializeApp(
    FIREBASE_CONFIG,
    APP_NAME
  );

  auth = app.auth();
  db = app.database();

  activeRef = db.ref("control/activePlayback");

  db.ref(".info/serverTimeOffset").on("value", snapshot => {

    serverOffset = Number(snapshot.val()) || 0;

  });

}

function serverNow() {
  return Date.now() + serverOffset;
}

/* =========================================
   MEDIA DETECTION
========================================= */

function getMedia() {

  try {

    return Array.from(
      document.querySelectorAll(MEDIA_SELECTOR)
    );

  } catch (error) {

    console.error("[Kulzzy] Invalid media selector.", error);

    return [];

  }

}

function isPlaying() {

  return getMedia().some(media =>
    !media.paused && !media.ended
  );

}

/* =========================================
   OPERATION QUEUE
========================================= */

function run(operation) {

  queue = queue.then(operation).catch(error => {

    console.error("[Kulzzy] Control error:", error);

  });

  return queue;

}

/* =========================================
   SAME-BROWSER CONTROL
========================================= */

try {

  if ("BroadcastChannel" in window) {

    channel = new BroadcastChannel(CHANNEL);

  }

} catch (error) {

  console.warn("[Kulzzy] BroadcastChannel unavailable.");

}

function broadcastPlay() {

  if (!channel) return;

  channel.postMessage({

    type: "KULZZY_MEDIA_PLAY",
    playerId: PLAYER_ID,
    playerName: PLAYER_NAME,
    sessionId: SESSION_ID

  });

}

if (channel) {

  channel.addEventListener("message", event => {

    const message = event.data;

    if (
      !message ||
      message.type !== "KULZZY_MEDIA_PLAY" ||
      message.sessionId === SESSION_ID
    ) return;

    if (isPlaying() || wantsPlayback) {

      stopPlayer(
        "Another Kulzzy player started."
      );

    }

  });

}

/* =========================================
   STOP HEARTBEAT
========================================= */

function stopHeartbeat() {

  clearInterval(heartbeatTimer);
  heartbeatTimer = null;

}

/* =========================================
   RELEASE OWNERSHIP
========================================= */

function releasePlayback() {

  stopHeartbeat();

  registered = false;

  if (!activeRef || !userId) {
    return Promise.resolve();
  }

  return run(async () => {

    await activeRef.transaction(current => {

      if (
        !current ||
        current.uid !== userId ||
        current.sessionId !== SESSION_ID
      ) {

        return;

      }

      return null;

    }, undefined, false);

  });

}

/* =========================================
   HEARTBEAT
========================================= */

function startHeartbeat() {

  stopHeartbeat();

  if (!registered || !wantsPlayback) return;

  heartbeatTimer = setInterval(() => {

    if (
      !connected ||
      !ready ||
      !registered ||
      !wantsPlayback ||
      stopping
    ) return;

    run(async () => {

      const result = await activeRef.transaction(current => {

        if (
          !current ||
          current.uid !== userId ||
          current.sessionId !== SESSION_ID
        ) {

          return;

        }

        current.lastSeen = serverNow();

        return current;

      }, undefined, false);

      const owner = result.snapshot.val();

      if (
        !result.committed ||
        !owner ||
        owner.sessionId !== SESSION_ID
      ) {

        stopPlayer("Playback ownership lost.");

      }

    });

  }, HEARTBEAT);

}

/* =========================================
   CLAIM THE SHARED PLAYBACK LOCK
========================================= */

function claimPlayback() {

  if (
    !ready ||
    !connected ||
    !wantsPlayback ||
    stopping
  ) return Promise.resolve(false);

  return run(async () => {

    if (
      !ready ||
      !connected ||
      !wantsPlayback ||
      stopping
    ) return false;

    const timestamp = serverNow();

    const claim = {

      uid: userId,
      sessionId: SESSION_ID,

      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,

      playing: true,

      startedAt: timestamp,
      lastSeen: timestamp

    };

    const result = await activeRef.transaction(
      current => {

        /*
          ONE shared Firebase ownership record.
          Every player competes for the same record.
        */

        return claim;

      },
      undefined,
      false
    );

    const owner = result.snapshot.val();

    if (
      !result.committed ||
      !owner ||
      owner.uid !== userId ||
      owner.sessionId !== SESSION_ID
    ) {

      if (wantsPlayback) {
        stopPlayer("Another player owns playback.");
      }

      return false;

    }

    registered = true;
    lastClaimTime = timestamp;

    startHeartbeat();

    console.log(
      "[Kulzzy] Playback ownership acquired:",
      PLAYER_NAME
    );

    return true;

  });

}

/* =========================================
   PLAY REQUEST
========================================= */

function notifyPlay() {

  if (stopping) return;

  wantsPlayback = true;

  broadcastPlay();

  if (ready && connected) {

    claimPlayback();

  }

}

/* =========================================
   STOP REQUEST
========================================= */

function notifyStop(force) {

  clearTimeout(stopCheckTimer);

  if (!force && isPlaying()) return;

  wantsPlayback = false;

  releasePlayback();

}

/* =========================================
   STOP LOCAL PLAYER
========================================= */

function stopPlayer(reason) {

  if (stopping) return;

  stopping = true;

  wantsPlayback = false;

  registered = false;

  clearTimeout(stopCheckTimer);

  stopHeartbeat();

  const detail = {

    reason: reason || "Another player started.",

    playerId: PLAYER_ID,
    playerName: PLAYER_NAME,
    sessionId: SESSION_ID,

    controller: "KULZZY_UNIVERSAL_MEDIA_CONTROL"

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

  if (typeof CONFIG.stop === "function") {

    try {

      CONFIG.stop(detail);

    } catch (error) {

      console.error("[Kulzzy] Stop callback failed:", error);

    }

  }

  /*
    Stop every audio/video element on this page.
  */

  getMedia().forEach(media => {

    try {

      media.pause();

    } catch (error) {}

  });

  releasePlayback();

  clearTimeout(resetTimer);

  resetTimer = setTimeout(() => {

    stopping = false;

  }, 1200);

}

/* =========================================
   MONITOR GLOBAL PLAYBACK
========================================= */

function monitorPlayback() {

  activeRef.on("value", snapshot => {

    if (!ready) return;

    const owner = snapshot.val();

    if (!owner || owner.playing !== true) return;

    const lastSeen = Number(owner.lastSeen) || 0;

    /*
      Ignore abandoned or disconnected sessions.
    */

    if (
      !lastSeen ||
      serverNow() - lastSeen > TIMEOUT
    ) return;

    const isOwner =
      owner.uid === userId &&
      owner.sessionId === SESSION_ID;

    if (!isOwner) {

      if (isPlaying() || wantsPlayback) {

        stopPlayer(
          "Playback taken by " +
          (owner.playerName || owner.playerId)
        );

      }

    }

  }, error => {

    console.error(
      "[Kulzzy] Playback monitoring failed:",
      error
    );

  });

}

/* =========================================
   MEDIA EVENT LISTENERS
========================================= */

function handleMediaEvent(event) {

  if (stopping) return;

  const media = event.target;

  if (!media || typeof media.matches !== "function") {
    return;
  }

  let matches = false;

  try {

    matches = media.matches(MEDIA_SELECTOR);

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

    stopCheckTimer = setTimeout(() => {

      if (!isPlaying()) {

        notifyStop(true);

      }

    }, 400);

  }

}

[
  "play",
  "playing",
  "pause",
  "ended",
  "error"

].forEach(eventName => {

  document.addEventListener(
    eventName,
    handleMediaEvent,
    true
  );

});

/* =========================================
   FIREBASE CONNECTION
========================================= */

function monitorConnection() {

  db.ref(".info/connected").on("value", snapshot => {

    connected = snapshot.val() === true;

    if (!connected) {

      registered = false;

      stopHeartbeat();

      return;

    }

    console.log("[Kulzzy] Firebase connected.");

    if (
      ready &&
      wantsPlayback &&
      !stopping
    ) {

      claimPlayback();

    }

  });

}

/* =========================================
   AUTHENTICATION
========================================= */

async function initialize() {

  try {

    await initializeFirebase();

    monitorConnection();

    auth.onAuthStateChanged(async user => {

      try {

        if (!user) {

          await auth.signInAnonymously();

          return;

        }

        userId = user.uid;

        ready = true;

        /*
          Monitor the shared owner before accepting
          playback requests.
        */

        monitorPlayback();

        console.log(
          "[Kulzzy] Controller ready:",
          PLAYER_NAME
        );

        if (isPlaying()) {

          wantsPlayback = true;

          if (connected) {

            claimPlayback();

          }

        }

      } catch (error) {

        console.error(
          "[Kulzzy] Authentication error:",
          error
        );

      }

    });

  } catch (error) {

    console.error(
      "[Kulzzy] Initialization failed:",
      error
    );

  }

}

/* =========================================
   PAGE CLEANUP
========================================= */

function cleanup() {

  wantsPlayback = false;

  stopHeartbeat();

  clearTimeout(stopCheckTimer);

  if (activeRef && userId) {

    activeRef.transaction(current => {

      if (
        current &&
        current.uid === userId &&
        current.sessionId === SESSION_ID
      ) {

        return null;

      }

      return;

    }, undefined, false);

  }

  if (channel) {

    try {
      channel.close();
    } catch (error) {}

  }

}

window.addEventListener("pagehide", cleanup);

/* =========================================
   PUBLIC CONTROLLER
========================================= */

window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {

  playerId: PLAYER_ID,
  playerName: PLAYER_NAME,
  sessionId: SESSION_ID,

  notifyPlay: notifyPlay,
  notifyStop: notifyStop,

  stop: stopPlayer,

  getStatus: function () {

    return {

      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,
      sessionId: SESSION_ID,

      userId: userId,

      ready: ready,
      connected: connected,

      registeredPlaying: registered,

      locallyPlaying: isPlaying(),

      stopping: stopping,

      sameBrowserChannel: !!channel

    };

  }

};

/* START */

initialize();

})();
