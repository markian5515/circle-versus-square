"use strict";

(() => {
  const SESSION_KEY = "circleSquaresOnlineSession";
  const dom = {
    status: document.querySelector("[data-online-status]"),
    code: document.querySelector("[data-online-room-code]"),
    codeWrap: document.querySelector("[data-online-room-code-wrap]"),
    players: document.querySelector("[data-online-players]"),
    joinForm: document.querySelector("[data-online-join-form]"),
    joinInput: document.querySelector("#online-room-code-input"),
    leaderboard: document.querySelector("[data-leaderboard]"),
    connection: document.querySelector("[data-online-connection]")
  };

  function getBaseUrl() {
    const configured = window.GAME_CONFIG?.serverUrl?.trim();
    if (configured) return configured.replace(/\/+$/, "");
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return `${location.protocol}//${location.hostname}:3000`;
    }
    return "";
  }

  function showStatus(message, isError = false) {
    if (!dom.status) return;
    dom.status.textContent = message;
    dom.status.classList.toggle("is-error", isError);
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch (error) {
      console.warn("Не вдалося прочитати онлайн-сесію.", error);
      return null;
    }
  }

  function saveSession(session) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (error) {
      console.error("Не вдалося зберегти онлайн-сесію.", error);
      showStatus("Не вдалося зберегти сесію. Перевір сховище браузера.", true);
    }
  }

  async function request(path, options = {}) {
    const base = getBaseUrl();
    if (!base) throw new Error("Онлайн-сервер не налаштований. Вкажи його HTTPS-адресу у файлі online-config.js.");
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers }
    });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) throw new Error(body.error || `Помилка сервера (${response.status}).`);
    return body;
  }

  class OnlineClient {
    constructor() {
      this.socket = null;
      this.account = null;
      this.token = "";
      this.room = null;
      this.isConnected = false;
      this.connecting = null;
      this.reconnectTimer = 0;
      this.reconnectDelay = 1000;
      this.intentionalClose = false;
      this.pendingRoomAction = null;
      this.matchId = null;
      this.receivedResults = new Set();
    }

    async ensureSession() {
      const saved = readSession();
      const body = {
        name: window.getArenaProfile?.()?.name || "Гравець",
        color: window.getArenaProfile?.()?.color,
        ...(saved?.playerId && saved?.token ? { playerId: saved.playerId, token: saved.token } : {})
      };
      const result = await request("/api/session", { method: "POST", body: JSON.stringify(body) });
      const [playerId, token] = result.token.split(".");
      this.account = result.profile;
      this.token = token;
      saveSession({ playerId, token });
      this.applyProfile(result.profile);
      return { playerId, token };
    }

    async connect() {
      if (this.isConnected && this.socket?.readyState === WebSocket.OPEN) return;
      if (this.connecting) return this.connecting;
      this.connecting = (async () => {
        const session = await this.ensureSession();
        const base = getBaseUrl();
        const url = new URL(base);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
        url.search = "";
        const socket = new WebSocket(url);
        this.socket = socket;
        await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("Час очікування сервера вичерпано.")), 10_000);
          socket.addEventListener("open", () => {
            socket.send(JSON.stringify({
              type: "auth",
              playerId: session.playerId,
              token: session.token,
              profile: window.getArenaProfile?.() || { name: "Гравець" }
            }));
          }, { once: true });
          socket.addEventListener("message", (event) => {
            const message = this.parseMessage(event.data);
            if (message?.type !== "authenticated") return;
            clearTimeout(timeout);
            this.isConnected = true;
            this.reconnectDelay = 1000;
            this.account = message.profile;
            this.applyProfile(message.profile);
            dom.connection?.classList.add("is-hidden");
            resolve();
          });
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            reject(new Error("Не вдалося з'єднатися з онлайн-сервером."));
          }, { once: true });
          socket.addEventListener("close", (event) => {
            clearTimeout(timeout);
            if (!this.isConnected) reject(new Error(event.code === 4003 ? "Сервер не підтвердив онлайн-сесію." : "Онлайн-сервер недоступний."));
            this.onClose();
          });
        });
      })().finally(() => { this.connecting = null; });
      return this.connecting;
    }

    parseMessage(raw) {
      try {
        const message = JSON.parse(raw);
        if (message.type === "authenticated" && !this.isConnected) {
          this.isConnected = true;
          this.account = message.profile;
          this.applyProfile(message.profile);
        } else {
          this.handleMessage(message);
        }
        return message;
      } catch (error) {
        console.error("Некоректне повідомлення онлайн-сервера.", error);
        showStatus("Сервер надіслав некоректні дані.", true);
        return null;
      }
    }

    handleMessage(message) {
      if (message.type === "authenticated") {
        this.isConnected = true;
        this.account = message.profile;
        this.applyProfile(message.profile);
        return;
      }
      if (message.type === "joinedRoom") {
        this.room = message.room;
        if (message.profile) this.applyProfile(message.profile);
        this.renderRoom();
        showStatus("Кімната готова. Запроси друга або познач себе готовим.");
        return;
      }
      if (message.type === "roomCreated") {
        if (this.room) this.room.code = message.code;
        this.renderRoom();
        return;
      }
      if (message.type === "roomState") {
        this.room = message.room;
        this.renderRoom();
        return;
      }
      if (message.type === "leftRoom") {
        this.room = null;
        this.renderRoom();
        showStatus("Ти залишив кімнату.");
        return;
      }
      if (message.type === "matchStarted") {
        this.matchId = message.matchId;
        this.room = this.room ? { ...this.room, phase: "playing" } : this.room;
        window.startOnlineArena?.(message);
        return;
      }
      if (message.type === "gameState") {
        window.applyOnlineSnapshot?.(message.state);
        return;
      }
      if (message.type === "gameEvent") {
        window.showArenaToast?.(message.message);
        return;
      }
      if (message.type === "playerEliminated") {
        window.showArenaToast?.(`${message.name} вибув із матчу.`);
        return;
      }
      if (message.type === "matchResult") {
        if (this.receivedResults.has(message.matchId)) return;
        this.receivedResults.add(message.matchId);
        const result = message.results?.find((entry) => entry.playerId === this.account?.playerId);
        if (result?.profile) this.applyProfile(result.profile);
        window.finishOnlineMatch?.(message, result || null);
        return;
      }
      if (message.type === "leaderboard") {
        this.renderLeaderboard(message.leaderboard || []);
        return;
      }
      if (message.type === "error") {
        showStatus(message.message || "Помилка онлайн-сервера.", true);
        window.showArenaToast?.(message.message || "Помилка онлайн-сервера.");
      }
    }

    applyProfile(profile) {
      this.account = profile;
      window.applyOnlineProfile?.(profile);
      if (window.renderShopForOnline) window.renderShopForOnline();
    }

    renderRoom() {
      const room = this.room;
      if (!dom.code || !dom.players) return;
      dom.code.textContent = room?.code || "";
      dom.codeWrap?.classList.toggle("is-hidden", !room);
      dom.players.replaceChildren();
      const readyButton = document.querySelector('[data-action="online-ready"]');
      const startButton = document.querySelector('[data-action="online-start"]');
      const leaveButton = document.querySelector('[data-action="online-leave"]');
      if (!room) {
        if (readyButton) readyButton.disabled = true;
        if (startButton) { startButton.disabled = true; startButton.classList.add("is-hidden"); }
        if (leaveButton) leaveButton.disabled = true;
        return;
      }
      room.players.forEach((player) => {
        const item = document.createElement("li");
        item.className = "online-player";
        const dot = document.createElement("span");
        dot.className = "online-player-dot";
        dot.style.setProperty("--player-color", player.color || "#68f1e2");
        const name = document.createElement("strong");
        name.textContent = player.name;
        const status = document.createElement("small");
        status.textContent = !player.connected ? "З'ЄДНАННЯ…" : room.phase === "playing" ? (player.alive ? "У ГРІ" : "СПОСТЕРІГАЄ") : player.ready ? "ГОТОВИЙ" : "ОЧІКУЄ";
        item.append(dot, name, status);
        if (player.id === room.ownerId) {
          const owner = document.createElement("span");
          owner.className = "online-owner";
          owner.textContent = "ВЛАСНИК";
          item.append(owner);
        }
        dom.players.append(item);
      });
      const ownPlayer = room.players.find((player) => player.id === this.account?.playerId);
      if (readyButton) {
        readyButton.textContent = ownPlayer?.ready ? "НЕ ГОТОВИЙ" : "ГОТОВИЙ";
        readyButton.disabled = room.phase !== "lobby";
      }
      if (leaveButton) leaveButton.disabled = false;
      if (startButton) {
        startButton.classList.toggle("is-hidden", room.ownerId !== this.account?.playerId || room.phase !== "lobby");
        startButton.disabled = room.phase !== "lobby" || room.players.filter((player) => player.ready && player.connected).length < 2;
      }
    }

    renderLeaderboard(players) {
      if (!dom.leaderboard) return;
      dom.leaderboard.replaceChildren();
      if (!players.length) {
        const empty = document.createElement("p");
        empty.textContent = "Тут поки порожньо. Зіграй онлайн-матч першим!";
        dom.leaderboard.append(empty);
        return;
      }
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const header = document.createElement("tr");
      ["#", "ГРАВЕЦЬ", "ПЕРЕМОГИ", "МАТЧІ", "РЕЙТИНГ", "КУБКИ"].forEach((label) => {
        const cell = document.createElement("th");
        cell.textContent = label;
        header.append(cell);
      });
      head.append(header);
      const body = document.createElement("tbody");
      players.forEach((player) => {
        const row = document.createElement("tr");
        [player.rank, player.name, player.wins, player.matches, player.rating, player.cups].forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = String(value);
          row.append(cell);
        });
        body.append(row);
      });
      table.append(head, body);
      dom.leaderboard.append(table);
    }

    send(payload) {
      if (this.socket?.readyState !== WebSocket.OPEN) return false;
      this.socket.send(JSON.stringify(payload));
      return true;
    }

    async createRoom() {
      await this.connect();
      this.room = null;
      this.send({ type: "createRoom" });
    }

    async quickJoin() {
      await this.connect();
      this.room = null;
      this.send({ type: "quickJoin" });
    }

    async joinRoom(code) {
      await this.connect();
      this.send({ type: "joinRoom", code });
    }

    async toggleReady() {
      if (!this.room) return;
      const ownPlayer = this.room.players.find((player) => player.id === this.account?.playerId);
      this.send({ type: "ready", ready: !ownPlayer?.ready });
    }

    startMatch() { this.send({ type: "startMatch" }); }
    leaveRoom() { this.send({ type: "leaveRoom" }); }
    input(x, y) { this.send({ type: "input", x, y }); }
    ability() { this.send({ type: "ability" }); }

    async loadLeaderboard() {
      try {
        const result = await request("/api/leaderboard");
        this.renderLeaderboard(result.leaderboard || []);
      } catch (error) {
        if (dom.leaderboard) dom.leaderboard.textContent = error.message;
      }
    }

    async purchaseOrEquip(itemType, itemId, action) {
      await this.connect();
      const result = await request("/api/store", {
        method: "POST",
        headers: { Authorization: `Bearer ${readSession()?.playerId}.${this.token}` },
        body: JSON.stringify({ action, itemType, itemId })
      });
      this.applyProfile(result.profile);
      return result.profile;
    }

    async copyInvite(useLink) {
      if (!this.room?.code) return;
      const value = useLink ? `${location.origin}${location.pathname}?room=${this.room.code}` : this.room.code;
      try {
        await navigator.clipboard.writeText(value);
        showStatus(useLink ? "Посилання-запрошення скопійовано." : "Код кімнати скопійовано.");
      } catch (error) {
        showStatus("Браузер не дозволив скопіювати. Код: " + this.room.code, true);
      }
    }

    async runAction(action) {
      try {
        showStatus("ПІДКЛЮЧЕННЯ…");
        await action();
      } catch (error) {
        showStatus(error.message, true);
      }
    }

    showError(message) {
      showStatus(message, true);
    }

    onClose() {
      const wasConnected = this.isConnected;
      this.isConnected = false;
      if (dom.connection && window.getOnlineMode?.()) {
        dom.connection.classList.remove("is-hidden");
        dom.connection.replaceChildren();
        const text = document.createElement("span");
        text.textContent = "З'ЄДНАННЯ ВТРАЧЕНО";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "ПЕРЕПІДКЛЮЧИТИСЯ";
        button.addEventListener("click", () => this.runAction(() => this.connect()));
        dom.connection.append(text, button);
      }
      if (wasConnected) showStatus("З'єднання втрачено. Спроба перепідключення…", true);
      this.scheduleReconnect();
    }

    scheduleReconnect() {
      if (this.intentionalClose || this.reconnectTimer) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(15_000, Math.ceil(this.reconnectDelay * 1.7));
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = 0;
        this.connect().catch((error) => {
          showStatus(error.message, true);
          this.scheduleReconnect();
        });
      }, delay);
    }

    async loadInvite() {
      const code = new URLSearchParams(location.search).get("room");
      if (!code || !/^[A-HJ-NP-Z2-9]{6}$/i.test(code)) return;
      window.openOnlineModal?.();
      await this.runAction(() => this.joinRoom(code));
    }
  }

  const client = new OnlineClient();
  window.onlineClient = client;
  window.setInterval(() => {
    if (client.isConnected && window.getOnlineMode?.()) {
      const input = window.getOnlineInput?.() || { x: 0, y: 0 };
      client.input(input.x, input.y);
    }
  }, 50);
  document.addEventListener("DOMContentLoaded", () => {
    const queryCode = new URLSearchParams(location.search).get("room");
    if (queryCode) window.setTimeout(() => client.loadInvite(), 50);
  });
})();
