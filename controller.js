/* ==========================================
   KULZZY UNIVERSAL MEDIA CONTROL
   CENTRAL MEDIA CONTROLLER
   Version 1.0
========================================== */

(function () {
  "use strict";

  if (window.KULZZY_UNIVERSAL_MEDIA_CONTROL) return;

  const CONFIG = {
    RADIO_ORIGIN: "https://kulzzy-auto-player.pages.dev",

    MAIN_APP_ORIGIN: "https://kulzzy-radio-main-app.pages.dev",

    TRUSTED_PLAYER_ORIGINS: [
      "https://kulzzy.github.io"
    ],

    RADIO_FRAME_ID: "kulzzyRadioPlayerFrame"
  };

  const activePlayers = Object.create(null);
  const processedCommands = Object.create(null);

  let radioPausedByController = false;
  let lastRadioCommand = null;

  function getRadioFrame() {
    return document.getElementById(CONFIG.RADIO_FRAME_ID);
  }

  function getActivePlayers() {
    return Object.keys(activePlayers);
  }

  function sendRadioCommand(action) {
    const radioFrame = getRadioFrame();

    if (!radioFrame || !radioFrame.contentWindow) {
      lastRadioCommand = "Radio player iframe not found";

      console.warn(
        "[Kulzzy Media Control] Radio player not found."
      );

      return false;
    }

    radioFrame.contentWindow.postMessage(
      {
        type: "KULZZY_MEDIA_CONTROL",
        action: action,
        activePlayers: getActivePlayers(),
        timestamp: Date.now()
      },
      CONFIG.RADIO_ORIGIN
    );

    radioPausedByController = action === "pause";
    lastRadioCommand = action;

    console.log(
      "[Kulzzy Media Control] Radio command:",
      action
    );

    return true;
  }

  function updateRadio() {
    const players = getActivePlayers();

    if (players.length > 0) {
      if (!radioPausedByController) {
        sendRadioCommand("pause");
      }
    } else {
      if (radioPausedByController) {
        sendRadioCommand("resume");
      }
    }
  }

  function sendAcknowledgement(event, data, status) {
    if (!event.source) return;

    try {
      event.source.postMessage(
        {
          type: "KULZZY_MEDIA_CONTROL_ACK",
          playerId: data.playerId,
          action: data.action,
          status: status,
          activePlayers: getActivePlayers().length,
          activePlayerNames: getActivePlayers(),
          radioPaused: radioPausedByController,
          radioCommand: lastRadioCommand,
          radioFrameFound: !!getRadioFrame(),
          timestamp: Date.now()
        },
        event.origin
      );
    } catch (error) {
      console.warn(
        "[Kulzzy Media Control] Acknowledgement failed:",
        error
      );
    }
  }

  function handlePlayerMessage(event) {
    if (!CONFIG.TRUSTED_PLAYER_ORIGINS.includes(event.origin)) {
      return;
    }

    const data = event.data;

    if (!data || data.type !== "KULZZY_MEDIA_CONTROL") {
      return;
    }

    const playerId = String(data.playerId || "").trim();
    const action = String(data.action || "").toLowerCase();

    if (!playerId || playerId.length > 100) {
      return;
    }

    if (!["play", "stop", "pause", "ended", "error"].includes(action)) {
      return;
    }

    const commandId = String(data.commandId || "");

    if (commandId && processedCommands[commandId]) {
      sendAcknowledgement(event, data, "duplicate");
      return;
    }

    if (commandId) {
      processedCommands[commandId] = Date.now();

      const oldCommands = Object.keys(processedCommands);

      if (oldCommands.length > 500) {
        oldCommands.slice(0, 200).forEach(function (id) {
          delete processedCommands[id];
        });
      }
    }

    if (action === "play") {
      activePlayers[playerId] = {
        origin: event.origin,
        startedAt: Date.now()
      };
    } else {
      delete activePlayers[playerId];
    }

    updateRadio();

    sendAcknowledgement(event, data, "received");

    console.log(
      "[Kulzzy Media Control] Player:",
      playerId,
      "Action:",
      action,
      "Active players:",
      getActivePlayers()
    );
  }

  window.addEventListener("message", handlePlayerMessage);

  window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {
    version: "1.0",

    getActivePlayers: getActivePlayers,

    getStatus: function () {
      return {
        activePlayers: getActivePlayers(),
        radioPaused: radioPausedByController,
        lastRadioCommand: lastRadioCommand,
        radioFrameFound: !!getRadioFrame()
      };
    },

    reset: function () {
      Object.keys(activePlayers).forEach(function (id) {
        delete activePlayers[id];
      });

      updateRadio();
    }
  };

  console.log(
    "[Kulzzy Media Control] Central controller loaded."
  );

})();
