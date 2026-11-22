/* ==========================================
   KULZZY UNIVERSAL MEDIA CONTROL
   CLOUDFLARE DURABLE OBJECT VERSION
   ONE PLAYER AT A TIME
========================================== */

(function () {
  "use strict";

  if (window.KULZZY_UNIVERSAL_MEDIA_CONTROL) return;

  const CONFIG = window.KULZZY_MEDIA_PLAYER_CONFIG || {};

  const PLAYER_ID = String(
    CONFIG.playerId || location.hostname + location.pathname
  );

  const PLAYER_NAME = String(
    CONFIG.playerName || PLAYER_ID
  );

  const MEDIA_SELECTOR = CONFIG.mediaSelector || "audio,video";

  const SERVER_URL =
    "wss://kulzzy-media-control.donshangti2.workers.dev/ws?source=" +
    encodeURIComponent(PLAYER_ID);

  const SESSION_ID =
    crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);

  let socket = null;
  let ready = false;
  let wantsPlayback = false;
  let stopping = false;
  let reconnectTimer = null;
  let pauseTimer = null;
  let lastError = "";

  function log() {
    console.log("[KULZZY MEDIA CONTROL]", ...arguments);
  }

  function reportError(error) {
    lastError = String(error);
    console.error("[KULZZY MEDIA CONTROL]", error);
  }

  function getMedia() {
    try {
      return Array.from(
        document.querySelectorAll(MEDIA_SELECTOR)
      );
    } catch (error) {
      reportError(error);
      return [];
    }
  }

  function pageIsPlaying() {
    return getMedia().some(function (media) {
      return !media.paused && !media.ended;
    });
  }

  function send(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(JSON.stringify(data));
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function requestPlay() {
    if (stopping) return;

    clearTimeout(pauseTimer);
    wantsPlayback = true;

    if (socket && socket.readyState === WebSocket.OPEN) {
      send({
        type: "play",
        playbackId: SESSION_ID
      });
    }
  }

  function requestStop() {
    clearTimeout(pauseTimer);

    pauseTimer = setTimeout(function () {
      if (pageIsPlaying()) return;

      wantsPlayback = false;

      send({
        type: "stop"
      });
    }, 400);
  }

  function stopLocalPlayer(reason) {
    if (stopping) return;

    stopping = true;
    wantsPlayback = false;

    clearTimeout(pauseTimer);

    const detail = {
      reason: reason || "Another Kulzzy player has started.",
      playerId: PLAYER_ID,
      playerName: PLAYER_NAME,
      sessionId: SESSION_ID,
      controller: "KULZZY_UNIVERSAL_MEDIA_CONTROL"
    };

    log("STOP COMMAND:", detail.reason);

    try {
      window.dispatchEvent(
        new CustomEvent("kulzzy:media-stop", {
          detail: detail
        })
      );
    } catch (error) {}

    try {
      window.postMessage({
        type: "KULZZY_UNIVERSAL_MEDIA_STOP",
        detail: detail
      }, "*");
    } catch (error) {}

    if (typeof window.KULZZY_STOP_PLAYER === "function") {
      try {
        window.KULZZY_STOP_PLAYER(detail);
      } catch (error) {
        reportError(error);
      }
    }

    if (typeof CONFIG.stop === "function") {
      try {
        CONFIG.stop(detail);
      } catch (error) {
        reportError(error);
      }
    }

    getMedia().forEach(function (media) {
      try {
        media.pause();
      } catch (error) {}
    });

    send({
      type: "stop"
    });

    setTimeout(function () {
      stopping = false;
    }, 1200);
  }

  function connect() {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
       socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      socket = new WebSocket(SERVER_URL);
    } catch (error) {
      reportError(error);
      scheduleReconnect();
      return;
    }

    socket.onopen = function () {
      ready = true;
      lastError = "";

      log("CONNECTED:", PLAYER_NAME);

      if (wantsPlayback || pageIsPlaying()) {
        requestPlay();
      }
    };

    socket.onmessage = function (event) {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (data.type === "connected") {
        log("SERVER CONFIRMED CONNECTION");
        return;
      }

      if (data.type === "stop") {
        stopLocalPlayer(
          data.reason || "Another Kulzzy player has started."
        );
        return;
      }

      if (data.type === "playback-confirmed") {
        log("PLAYBACK APPROVED:", PLAYER_NAME);
        return;
      }

      if (data.type === "error") {
        reportError(data.message);
      }
    };

    socket.onerror = function () {
      lastError = "Cloudflare connection error";
      log(lastError);
    };

    socket.onclose = function () {
      ready = false;
      socket = null;

      log("DISCONNECTED. RECONNECTING...");

      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(function () {
      connect();
    }, 3000);
  }

  function attachMediaEvents() {
    ["play", "playing"].forEach(function (eventName) {
      document.addEventListener(
        eventName,
        function (event) {
          const target = event.target;

          if (!target || typeof target.matches !== "function") return;

          try {
            if (target.matches(MEDIA_SELECTOR)) {
              requestPlay();
            }
          } catch (error) {}
        },
        true
      );
    });

    ["pause", "ended", "error"].forEach(function (eventName) {
      document.addEventListener(
        eventName,
        function (event) {
          const target = event.target;

          if (!target || typeof target.matches !== "function") return;

          try {
            if (target.matches(MEDIA_SELECTOR)) {
              requestStop();
            }
          } catch (error) {}
        },
        true
      );
    });
  }

  window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {
    playerId: PLAYER_ID,
    playerName: PLAYER_NAME,
    sessionId: SESSION_ID,

    notifyPlay: requestPlay,
    notifyStop: requestStop,
    stop: stopLocalPlayer,

    getStatus: function () {
      return {
        playerId: PLAYER_ID,
        playerName: PLAYER_NAME,
        connected: ready,
        locallyPlaying: pageIsPlaying(),
        wantsPlayback: wantsPlayback,
        lastError: lastError
      };
    }
  };

  attachMediaEvents();
  connect();

  log("CONTROLLER INITIALIZED:", PLAYER_NAME);

})();
