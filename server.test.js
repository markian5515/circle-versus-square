import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createGameServer } from "./server.js";

function waitFor(socket, predicate, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for server message."));
    }, timeout);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    }
    socket.on("message", onMessage);
  });
}

async function createSession(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function connectClient(baseUrl, session) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const authenticated = waitFor(socket, (message) => message.type === "authenticated");
  const [playerId, token] = session.token.split(".");
  socket.send(JSON.stringify({ type: "auth", playerId, token, profile: { name: session.profile.name } }));
  await authenticated;
  return socket;
}

test("authoritative online rooms and game snapshots are shared by players", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "circle-squares-"));
  const filePath = path.join(tempDirectory, "players.json");
  const instance = await createGameServer({ port: 0, host: "127.0.0.1", dataFile: filePath });
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  try {
    const firstSession = await createSession(baseUrl, "Гравець Один");
    const secondSession = await createSession(baseUrl, "Гравець Два");
    const first = await connectClient(baseUrl, firstSession);
    sockets.push(first);
    const firstJoined = waitFor(first, (message) => message.type === "joinedRoom");
    first.send(JSON.stringify({ type: "createRoom" }));
    const room = await firstJoined;
    assert.match(room.room.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(room.room.private, true);

    const second = await connectClient(baseUrl, secondSession);
    sockets.push(second);
    const secondJoined = waitFor(second, (message) => message.type === "joinedRoom");
    second.send(JSON.stringify({ type: "joinRoom", code: room.room.code }));
    const joined = await secondJoined;
    assert.equal(joined.room.players.length, 2);

    const firstLobby = waitFor(first, (message) => message.type === "roomState" && message.room.players.length === 2);
    first.send(JSON.stringify({ type: "ready", ready: true }));
    await firstLobby;
    const secondLobby = waitFor(second, (message) => message.type === "roomState" && message.room.players.length === 2);
    second.send(JSON.stringify({ type: "ready", ready: true }));
    await secondLobby;

    const firstStarted = waitFor(first, (message) => message.type === "matchStarted");
    const secondStarted = waitFor(second, (message) => message.type === "matchStarted");
    first.send(JSON.stringify({ type: "startMatch" }));
    await Promise.all([firstStarted, secondStarted]);

    const firstState = await waitFor(first, (message) => message.type === "gameState");
    const secondState = await waitFor(second, (message) => message.type === "gameState");
    assert.equal(firstState.state.players.length, 2);
    assert.equal(secondState.state.players.length, 2);
    assert.deepEqual(firstState.state.enemies.map((enemy) => enemy.id), secondState.state.enemies.map((enemy) => enemy.id));
    assert.deepEqual(firstState.state.pickups.map((pickup) => pickup.id), secondState.state.pickups.map((pickup) => pickup.id));
    assert.deepEqual(firstState.state.world, { width: 3600, height: 2400 });

    const playerX = firstState.state.self.x;
    first.send(JSON.stringify({ type: "input", x: 1, y: 0 }));
    let movedState = firstState;
    const endAt = Date.now() + 1800;
    while (Date.now() < endAt && movedState.state.self.x <= playerX + 12) {
      movedState = await waitFor(first, (message) => message.type === "gameState", 1500);
    }
    assert.ok(movedState.state.self.x > playerX + 12, "server accepted the player's movement input");

    const forged = waitFor(first, (message) => message.type === "error");
    first.send(JSON.stringify({ type: "awardTrophies", amount: 999999, wins: 100 }));
    assert.match((await forged).message, /Невідома команда/);

    const purchaseResponse = await fetch(`${baseUrl}/api/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firstSession.token}` },
      body: JSON.stringify({ action: "purchase", itemType: "ability", itemId: "dash" })
    });
    assert.equal(purchaseResponse.status, 409, "client cannot buy online items without server-issued currency");
  } finally {
    for (const socket of sockets) socket.terminate();
    await instance.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("server rejects unknown origins", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "circle-squares-origin-"));
  const instance = await createGameServer({ port: 0, host: "127.0.0.1", dataFile: path.join(tempDirectory, "players.json") });
  try {
    const response = await fetch(`http://127.0.0.1:${instance.server.address().port}/api/leaderboard`, {
      headers: { Origin: "https://attacker.example" }
    });
    assert.equal(response.status, 403);
  } finally {
    await instance.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
