/* ==========================================
   KULZZY UNIVERSAL MEDIA CONTROL
   CENTRAL MEDIA CONTROLLER
   Version 2.0
========================================== */

(function () {
    "use strict";

    if (window.KULZZY_UNIVERSAL_MEDIA_CONTROL) {
        console.warn("[Kulzzy Media] Controller already running.");
        return;
    }

    const CONFIG = {
        RADIO_ORIGIN: "https://kulzzy-auto-player.pages.dev",

        TRUSTED_PLAYER_ORIGINS: [
            "https://kulzzy.github.io"
        ],

        RADIO_FRAME_ID: "kulzzyRadioPlayerFrame"
    };

    const activePlayers = Object.create(null);
    const processedCommands = Object.create(null);

    let radioPausedByController = false;
    let lastRadioCommand = "none";
    let controllerReady = true;

    function getRadioFrame() {
        return document.getElementById(CONFIG.RADIO_FRAME_ID);
    }

    function getActivePlayers() {
        return Object.keys(activePlayers);
    }

    function sendRadioCommand(action) {
        const radioFrame = getRadioFrame();

        if (!radioFrame || !radioFrame.contentWindow) {
            lastRadioCommand = "RADIO_FRAME_NOT_FOUND";

            console.error(
                "[Kulzzy Media] Radio iframe not found."
            );

            return false;
        }

        try {
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
                "[Kulzzy Media] Radio command sent:",
                action
            );

            return true;

        } catch (error) {
            lastRadioCommand = "SEND_FAILED";

            console.error(
                "[Kulzzy Media] Radio command failed:",
                error
            );

            return false;
        }
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

    function acknowledgePlayer(event, data, status) {
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
                    controllerVersion: "2.0",
                    timestamp: Date.now()
                },
                event.origin
            );

        } catch (error) {
            console.error(
                "[Kulzzy Media] Acknowledgement failed:",
                error
            );
        }
    }

    function handlePlayerMessage(event) {

        console.log(
            "[Kulzzy Media] Message received from:",
            event.origin
        );

        if (!CONFIG.TRUSTED_PLAYER_ORIGINS.includes(event.origin)) {
            console.warn(
                "[Kulzzy Media] Untrusted message origin:",
                event.origin
            );
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
            console.warn(
                "[Kulzzy Media] Invalid action:",
                action
            );
            return;
        }

        const commandId = String(data.commandId || "");

        if (commandId && processedCommands[commandId]) {
            acknowledgePlayer(event, data, "duplicate");
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

        acknowledgePlayer(event, data, "received");

        console.log(
            "[Kulzzy Media] Player:",
            playerId,
            "| Action:",
            action,
            "| Active players:",
            getActivePlayers()
        );
    }

    window.addEventListener(
        "message",
        handlePlayerMessage,
        false
    );

    window.KULZZY_UNIVERSAL_MEDIA_CONTROL = {

        version: "2.0",

        getActivePlayers: getActivePlayers,

        getStatus: function () {
            return {
                version: "2.0",
                controllerReady: controllerReady,
                activePlayers: getActivePlayers(),
                radioPaused: radioPausedByController,
                lastRadioCommand: lastRadioCommand,
                radioFrameFound: !!getRadioFrame(),
                trustedOrigins: CONFIG.TRUSTED_PLAYER_ORIGINS
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
        "[Kulzzy Media] CENTRAL CONTROLLER VERSION 2.0 LOADED."
    );

})();
