import { createServer } from "node:http";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(ROOT, "data", "players.json");
let activeDataFile = DATA_FILE;
const MAX_PLAYERS = 8;
const WORLD_WIDTH = 3600;
const WORLD_HEIGHT = 2400;
const TICK_MS = 1000 / 30;
const SNAPSHOT_MS = 50;
const RECONNECT_GRACE_MS = 25_000;
const ABILITIES = {
  dash: { cooldown: 8, duration: 0 },
  shield: { cooldown: 18, duration: 5 },
  magnet: { cooldown: 18, duration: 8 },
  wave: { cooldown: 18, duration: 0 },
  speed: { cooldown: 18, duration: 7 },
  "extra-health": { cooldown: 0, duration: 0 },
  "slow-time": { cooldown: 20, duration: 7 },
  "double-cups": { cooldown: 24, duration: 10 }
};
const ENEMIES = {
  normal: { size: 15, speed: 58, multiplier: 1, color: "#ff5f83" },
  fast: { size: 12, speed: 58, multiplier: 1.55, color: "#ffad5b" },
  big: { size: 22, speed: 58, multiplier: 0.7, color: "#a277ff" },
  dash: { size: 14, speed: 58, multiplier: 1.05, color: "#ff62d0" }
};
const SKINS = new Set(["classic", "fire", "ice", "electric", "toxic", "ghost", "rainbow", "diamond", "gold-king", "galactic", "shadow", "legendary"]);
const ABILITY_IDS = new Set(Object.keys(ABILITIES));
const PLAYER_COLORS = new Set(["#68f1e2", "#ff67d8", "#ffc857", "#8c81ff", "#82f06a"]);
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "https://markian5515.github.io,http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000,http://localhost:8765,http://127.0.0.1:8765")
    .split(",").map((origin) => origin.trim()).filter(Boolean)
);
const rooms = new Map();
const accounts = new Map();
const socketsByPlayer = new Map();
const sessionRateLimits = new Map();
const roomJoinLimits = new Map();
let saveQueue = Promise.resolve();

function safeName(value) {
  if (typeof value !== "string") return "Гравець";
  const name = Array.from(value.trim()).slice(0, 16).join("");
  return name.replace(/[\u0000-\u001f<>]/g, "") || "Гравець";
}

function validOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

function sendJson(response, status, payload, origin = "") {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function readJson(request, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JSON object.");
  return value;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest();
}

function tokenMatches(token, savedHash) {
  if (typeof token !== "string" || !savedHash) return false;
  const candidate = hashToken(token);
  const expected = Buffer.from(savedHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function publicProfile(account) {
  return {
    playerId: account.id,
    name: account.name,
    color: account.color,
    balance: account.balance,
    ownedAbilities: account.ownedAbilities,
    equippedAbility: account.equippedAbility,
    ownedSkins: account.ownedSkins,
    selectedSkin: account.selectedSkin,
    matches: account.matches,
    wins: account.wins,
    cups: account.cups,
    bestSurvival: account.bestSurvival
  };
}

function persistAccounts() {
  saveQueue = saveQueue.then(async () => {
    await mkdir(path.dirname(activeDataFile), { recursive: true });
    const tempFile = `${activeDataFile}.tmp`;
    await writeFile(tempFile, JSON.stringify([...accounts.values()]), { encoding: "utf8", mode: 0o600 });
    await rename(tempFile, activeDataFile);
  });
  saveQueue = saveQueue.catch((error) => {
    console.error("Unable to persist online player data:", error);
  });
  return saveQueue;
}

async function loadAccounts() {
  try {
    const saved = JSON.parse(await readFile(activeDataFile, "utf8"));
    if (!Array.isArray(saved)) throw new Error("Player data must be an array.");
    for (const entry of saved) {
      if (!entry || typeof entry.id !== "string" || typeof entry.tokenHash !== "string") continue;
      accounts.set(entry.id, {
        id: entry.id,
        tokenHash: entry.tokenHash,
        name: safeName(entry.name),
        color: PLAYER_COLORS.has(entry.color) ? entry.color : "#68f1e2",
        balance: Number.isSafeInteger(entry.balance) && entry.balance >= 0 ? entry.balance : 0,
        ownedAbilities: Array.isArray(entry.ownedAbilities) ? [...new Set(entry.ownedAbilities.filter((id) => ABILITY_IDS.has(id)))] : [],
        equippedAbility: ABILITY_IDS.has(entry.equippedAbility) && entry.ownedAbilities?.includes(entry.equippedAbility) ? entry.equippedAbility : null,
        ownedSkins: Array.isArray(entry.ownedSkins) ? [...new Set(["classic", ...entry.ownedSkins.filter((id) => SKINS.has(id))])] : ["classic"],
        selectedSkin: SKINS.has(entry.selectedSkin) && entry.ownedSkins?.includes(entry.selectedSkin) ? entry.selectedSkin : "classic",
        matches: Number.isSafeInteger(entry.matches) && entry.matches >= 0 ? entry.matches : 0,
        wins: Number.isSafeInteger(entry.wins) && entry.wins >= 0 ? entry.wins : 0,
        cups: Number.isSafeInteger(entry.cups) && entry.cups >= 0 ? entry.cups : 0,
        bestSurvival: Number.isFinite(entry.bestSurvival) && entry.bestSurvival >= 0 ? entry.bestSurvival : 0,
        rewardedMatches: Array.isArray(entry.rewardedMatches) ? entry.rewardedMatches.slice(-1000) : [],
        roomId: null
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Unable to load online player data:", error);
  }
}

function authAccount(request) {
  const match = /^Bearer ([a-f0-9-]+)\.([A-Za-z0-9_-]+)$/i.exec(request.headers.authorization || "");
  if (!match) return null;
  const account = accounts.get(match[1]);
  return account && tokenMatches(match[2], account.tokenHash) ? account : null;
}

function getLeaderboard() {
  return [...accounts.values()]
    .sort((a, b) => (b.wins * 100 + b.cups) - (a.wins * 100 + a.cups) || b.wins - a.wins || b.bestSurvival - a.bestSurvival || a.name.localeCompare(b.name, "uk"))
    .slice(0, 50)
    .map((account, index) => ({
      rank: index + 1,
      name: account.name,
      wins: account.wins,
      matches: account.matches,
      rating: account.wins * 100 + account.cups,
      cups: account.cups,
      bestSurvival: Math.floor(account.bestSurvival)
    }));
}

function createPlayer(account, socket) {
  return {
    id: account.id,
    name: account.name,
    color: account.color,
    skin: account.selectedSkin,
    ability: account.equippedAbility,
    socket,
    connected: true,
    ready: false,
    participated: false,
    alive: true,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    inputX: 0,
    inputY: 0,
    hp: 3,
    maxHp: 3,
    invulnerable: 0,
    abilityCooldown: 0,
    effectTimer: 0,
    shieldTimer: 0,
    abilityUsed: null,
    cups: 0,
    survived: 0,
    disconnectedAt: 0
  };
}

function roomByPlayer(account) {
  return account.roomId ? rooms.get(account.roomId) || null : null;
}

function sendSocket(socket, type, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
}

function broadcastRoom(room, type, payload = {}) {
  for (const player of room.players.values()) sendSocket(player.socket, type, payload);
}

function roomSummary(room) {
  return {
    code: room.code,
    ownerId: room.ownerId,
    phase: room.phase,
    private: room.private,
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      skin: player.skin,
      ready: player.ready,
      connected: player.connected,
      alive: player.alive
    }))
  };
}

function sendRoomState(room) {
  broadcastRoom(room, "roomState", { room: roomSummary(room) });
}

function makeRoom(owner, isPrivate, socket) {
  let code;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  do {
    code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  const room = {
    code,
    ownerId: owner.id,
    private: isPrivate,
    phase: "lobby",
    players: new Map(),
    matchId: null,
    elapsed: 0,
    round: 1,
    enemies: [],
    pickups: [],
    pickupTimer: 0,
    enemyTimer: 1.4,
    eventSequence: 0,
    snapshotTimer: 0,
    lastResult: null
  };
  rooms.set(code, room);
  joinRoom(room, owner, socket);
  return room;
}

function joinRoom(room, account, socket) {
  const existingRoom = roomByPlayer(account);
  if (existingRoom && existingRoom !== room) leaveRoom(account, "Перехід до іншої кімнати");
  const prior = room.players.get(account.id);
  const player = prior || createPlayer(account, socket);
  player.socket = socket;
  player.connected = true;
  player.disconnectedAt = 0;
  player.name = account.name;
  player.color = account.color;
  player.skin = account.selectedSkin;
  player.ability = account.equippedAbility;
  room.players.set(account.id, player);
  account.roomId = room.code;
  if (!room.ownerId || !room.players.has(room.ownerId)) room.ownerId = account.id;
  sendSocket(socket, "joinedRoom", { room: roomSummary(room), profile: publicProfile(account) });
  sendRoomState(room);
}

function leaveRoom(account, reason = "Гравець залишив кімнату") {
  const room = roomByPlayer(account);
  if (!room) return;
  const player = room.players.get(account.id);
  if (player) {
    if (room.phase === "playing" && player.alive) {
      player.alive = false;
      player.survived = room.elapsed;
      emitEvent(room, `${player.name} залишив арену.`);
    }
    room.players.delete(account.id);
  }
  account.roomId = null;
  if (!room.players.size) {
    rooms.delete(room.code);
    return;
  }
  if (room.ownerId === account.id) {
    room.ownerId = room.players.keys().next().value;
    emitEvent(room, `Новий власник кімнати: ${room.players.get(room.ownerId).name}.`);
  }
  broadcastRoom(room, "playerLeft", { playerId: account.id, reason });
  sendRoomState(room);
  if (room.phase === "playing") checkMatchEnd(room);
}

function emitEvent(room, message) {
  room.eventSequence += 1;
  broadcastRoom(room, "gameEvent", { id: room.eventSequence, message, at: Date.now() });
}

function spawnPickup(room) {
  if (room.pickups.length >= 20) return false;
  let best = null;
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const point = { x: 30 + Math.random() * (WORLD_WIDTH - 60), y: 30 + Math.random() * (WORLD_HEIGHT - 60) };
    const playerGap = [...room.players.values()].filter((p) => p.alive).reduce((gap, p) => Math.min(gap, Math.hypot(point.x - p.x, point.y - p.y) - 105), Infinity);
    const enemyGap = room.enemies.reduce((gap, enemy) => Math.min(gap, Math.hypot(point.x - enemy.x, point.y - enemy.y) - enemy.size), Infinity);
    const pickupGap = room.pickups.reduce((gap, pickup) => Math.min(gap, Math.hypot(point.x - pickup.x, point.y - pickup.y) - 38), Infinity);
    const score = Math.min(playerGap, enemyGap, pickupGap);
    if (score > bestScore) { best = point; bestScore = score; }
    if (score >= 0) break;
  }
  if (!best || bestScore < 0) return false;
  const rarity = Math.random();
  room.pickups.push({
    id: randomUUID(),
    x: best.x,
    y: best.y,
    radius: 11,
    value: rarity < 0.035 ? 5 : rarity < 0.2 ? 3 : 1,
    phase: Math.random() * Math.PI * 2
  });
  return true;
}

function chooseEnemyType(round) {
  const roll = Math.random();
  if (round >= 7 && roll < 0.2) return "dash";
  if (round >= 5 && roll < 0.42) return "big";
  if (round >= 3 && roll < 0.72) return "fast";
  return "normal";
}

function spawnEnemy(room) {
  if (room.enemies.length >= 14) return;
  const type = chooseEnemyType(room.round);
  const spec = ENEMIES[type];
  let point = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const edge = Math.floor(Math.random() * 4);
    const candidate = {
      x: edge === 0 ? 10 : edge === 1 ? WORLD_WIDTH - 10 : Math.random() * WORLD_WIDTH,
      y: edge === 2 ? 10 : edge === 3 ? WORLD_HEIGHT - 10 : Math.random() * WORLD_HEIGHT
    };
    if ([...room.players.values()].filter((p) => p.alive).every((p) => Math.hypot(candidate.x - p.x, candidate.y - p.y) > 160)) {
      point = candidate;
      break;
    }
  }
  if (!point) return;
  room.enemies.push({
    id: randomUUID(), type, x: point.x, y: point.y, vx: 0, vy: 0,
    size: spec.size, speed: spec.speed * spec.multiplier,
    color: spec.color, dashCooldown: 2.4 + Math.random() * 1.7,
    dashTime: 0, dashX: 0, dashY: 0, stunTimer: 0, hitFlash: 0, phase: Math.random() * Math.PI * 2
  });
}

function startMatch(room) {
  if (room.phase !== "lobby") return;
  const players = [...room.players.values()];
  if (players.filter((player) => player.ready && player.connected).length < 2) return;
  room.phase = "playing";
  room.matchId = randomUUID();
  room.elapsed = 0;
  room.round = 1;
  room.enemies = [];
  room.pickups = [];
  room.pickupTimer = 0;
  room.enemyTimer = 1.2;
  room.snapshotTimer = 0;
  const active = players.filter((player) => player.connected);
  players.forEach((player) => {
    player.alive = false;
    player.ready = false;
    player.participated = false;
  });
  active.forEach((player, index) => {
    const angle = (Math.PI * 2 * index) / active.length;
    player.alive = true;
    player.participated = true;
    player.x = WORLD_WIDTH / 2 + Math.cos(angle) * 110;
    player.y = WORLD_HEIGHT / 2 + Math.sin(angle) * 110;
    player.vx = 0;
    player.vy = 0;
    player.inputX = 0;
    player.inputY = 0;
    player.maxHp = 3 + (accounts.get(player.id)?.ownedAbilities.includes("extra-health") ? 1 : 0);
    player.hp = player.maxHp;
    player.invulnerable = 1;
    player.abilityCooldown = 0;
    player.effectTimer = 0;
    player.shieldTimer = 0;
    player.abilityUsed = null;
    player.cups = 0;
    player.survived = 0;
  });
  for (let i = 0; i < 10; i += 1) spawnPickup(room);
  spawnEnemy(room);
  spawnEnemy(room);
  sendRoomState(room);
  broadcastRoom(room, "matchStarted", { matchId: room.matchId, world: { width: WORLD_WIDTH, height: WORLD_HEIGHT }, startedAt: Date.now() });
  emitEvent(room, "Матч почався! Ухиляйся, збирай кубки й залишся останнім.");
}

function randomDirection(player) {
  let x = player.inputX || player.vx;
  let y = player.inputY || player.vy;
  let length = Math.hypot(x, y);
  if (length < 0.1) { x = 1; y = 0; length = 1; }
  return { x: x / length, y: y / length };
}

function useAbility(room, player) {
  const ability = player.ability;
  const settings = ABILITIES[ability];
  if (!player.alive || !settings || ability === "extra-health" || player.abilityCooldown > 0) return;
  player.abilityCooldown = settings.cooldown;
  player.abilityUsed = ability;
  player.effectTimer = settings.duration;
  const direction = randomDirection(player);
  if (ability === "dash") {
    player.vx = direction.x * 620;
    player.vy = direction.y * 620;
    player.invulnerable = Math.max(player.invulnerable, 0.35);
  } else if (ability === "shield") {
    player.shieldTimer = settings.duration;
  } else if (ability === "wave") {
    for (const enemy of room.enemies) {
      const dx = enemy.x - player.x;
      const dy = enemy.y - player.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      if (distance > 280) continue;
      enemy.vx += (dx / distance) * 420;
      enemy.vy += (dy / distance) * 420;
      enemy.stunTimer = 1.1;
    }
  }
  emitEvent(room, `${player.name} активував здібність.`);
}

function applyInput(player, message) {
  if (!player.alive || typeof message.x !== "number" || typeof message.y !== "number" ||
      !Number.isFinite(message.x) || !Number.isFinite(message.y) ||
      Math.abs(message.x) > 1 || Math.abs(message.y) > 1) return false;
  const length = Math.hypot(message.x, message.y);
  const scale = length > 1 ? 1 / length : 1;
  player.inputX = message.x * scale;
  player.inputY = message.y * scale;
  return true;
}

function hitPlayer(room, player, enemy) {
  if (player.invulnerable > 0 || player.shieldTimer > 0 || !player.alive) return;
  player.hp -= 1;
  player.invulnerable = 0.7;
  const dx = player.x - enemy.x;
  const dy = player.y - enemy.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  player.vx = (dx / distance) * 270;
  player.vy = (dy / distance) * 270;
  enemy.vx -= (dx / distance) * 75;
  enemy.vy -= (dy / distance) * 75;
  enemy.hitFlash = 0.2;
  if (player.hp <= 0) {
    player.hp = 0;
    player.alive = false;
    player.survived = room.elapsed;
    player.inputX = 0;
    player.inputY = 0;
    emitEvent(room, `${player.name} вибув. 🪦`);
    broadcastRoom(room, "playerEliminated", { playerId: player.id, name: player.name, survived: Math.floor(player.survived) });
    checkMatchEnd(room);
  }
}

function collectPickups(room, dt) {
  for (let index = room.pickups.length - 1; index >= 0; index -= 1) {
    const pickup = room.pickups[index];
    pickup.phase += dt * 3.5;
    const magnet = [...room.players.values()]
      .filter((player) => player.alive && player.abilityUsed === "magnet" && player.effectTimer > 0)
      .map((player) => ({ player, distance: Math.hypot(player.x - pickup.x, player.y - pickup.y) }))
      .filter((entry) => entry.distance < 320 && entry.distance > 0)
      .sort((a, b) => a.distance - b.distance)[0];
    if (magnet) {
      const pull = Math.min(magnet.distance, 360 * dt);
      pickup.x += (magnet.player.x - pickup.x) / magnet.distance * pull;
      pickup.y += (magnet.player.y - pickup.y) / magnet.distance * pull;
    }
    const collector = [...room.players.values()].find((player) => player.alive &&
      Math.hypot(player.x - pickup.x, player.y - pickup.y) <= 16 + pickup.radius);
    if (!collector) continue;
    room.pickups.splice(index, 1);
    const value = pickup.value * (collector.abilityUsed === "double-cups" && collector.effectTimer > 0 ? 2 : 1);
    collector.cups += value;
    emitEvent(room, `${collector.name} зібрав ${pickup.value === 1 ? "кубок" : `рідкісний кубок ×${pickup.value}`} (+${value} 🏆).`);
  }
  const desired = Math.min(10 + Math.floor(room.elapsed / 60), 20);
  if (room.pickups.length < desired) {
    room.pickupTimer -= dt;
    if (room.pickupTimer <= 0) room.pickupTimer = spawnPickup(room) ? 1 : 0.5;
  } else room.pickupTimer = 0;
}

function updateEnemies(room, dt, difficulty) {
  const slow = [...room.players.values()].some((player) => player.alive && player.abilityUsed === "slow-time" && player.effectTimer > 0) ? 0.42 : 1;
  for (const enemy of room.enemies) {
    const target = [...room.players.values()].filter((player) => player.alive).sort((a, b) =>
      Math.hypot(a.x - enemy.x, a.y - enemy.y) - Math.hypot(b.x - enemy.x, b.y - enemy.y))[0];
    if (!target) continue;
    const dx = target.x - enemy.x;
    const dy = target.y - enemy.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const dirX = dx / distance;
    const dirY = dy / distance;
    if (enemy.type === "dash") {
      enemy.dashCooldown -= dt;
      enemy.dashTime = Math.max(0, enemy.dashTime - dt);
      if (enemy.dashCooldown <= 0) {
        enemy.dashTime = 0.52;
        enemy.dashCooldown = 3.5 + Math.random() * 0.7;
        enemy.dashX = dirX;
        enemy.dashY = dirY;
      }
    }
    enemy.stunTimer = Math.max(0, enemy.stunTimer - dt);
    if (enemy.stunTimer > 0) {
      enemy.x += enemy.vx * dt;
      enemy.y += enemy.vy * dt;
      enemy.vx *= Math.max(0, 1 - dt * 3);
      enemy.vy *= Math.max(0, 1 - dt * 3);
    } else {
      const topSpeed = enemy.speed * difficulty * slow * (enemy.type === "dash" && enemy.dashTime > 0 ? 2.15 : 1);
      const steer = Math.min(1, dt * 3.1);
      const targetX = enemy.type === "dash" && enemy.dashTime > 0 ? enemy.dashX * topSpeed : dirX * topSpeed;
      const targetY = enemy.type === "dash" && enemy.dashTime > 0 ? enemy.dashY * topSpeed : dirY * topSpeed;
      enemy.vx += (targetX - enemy.vx) * steer;
      enemy.vy += (targetY - enemy.vy) * steer;
      enemy.x += enemy.vx * dt;
      enemy.y += enemy.vy * dt;
    }
    enemy.x = Math.max(enemy.size / 2 + 4, Math.min(WORLD_WIDTH - enemy.size / 2 - 4, enemy.x));
    enemy.y = Math.max(enemy.size / 2 + 4, Math.min(WORLD_HEIGHT - enemy.size / 2 - 4, enemy.y));
    enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
    enemy.phase += dt * 2;
  }
}

function separateEnemies(room) {
  for (let pass = 0; pass < 8; pass += 1) {
    for (let i = 0; i < room.enemies.length; i += 1) {
      const first = room.enemies[i];
      for (let j = i + 1; j < room.enemies.length; j += 1) {
        const second = room.enemies[j];
        let dx = second.x - first.x;
        let dy = second.y - first.y;
        let distance = Math.hypot(dx, dy);
        const required = (first.size + second.size) / 2 + 2;
        if (distance >= required) continue;
        if (distance < 0.001) {
          const angle = (i * 2.399 + j * 1.618) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const overlap = required - distance;
        const pushX = (dx / distance) * overlap * 0.55;
        const pushY = (dy / distance) * overlap * 0.55;
        first.x -= pushX;
        first.y -= pushY;
        second.x += pushX;
        second.y += pushY;
        const relativeSpeed = ((second.vx - first.vx) * dx + (second.vy - first.vy) * dy) / distance;
        if (relativeSpeed < 0) {
          const impulse = -relativeSpeed * 0.52;
          first.vx -= (dx / distance) * impulse;
          first.vy -= (dy / distance) * impulse;
          second.vx += (dx / distance) * impulse;
          second.vy += (dy / distance) * impulse;
        }
        first.x = Math.max(first.size / 2 + 4, Math.min(WORLD_WIDTH - first.size / 2 - 4, first.x));
        first.y = Math.max(first.size / 2 + 4, Math.min(WORLD_HEIGHT - first.size / 2 - 4, first.y));
        second.x = Math.max(second.size / 2 + 4, Math.min(WORLD_WIDTH - second.size / 2 - 4, second.x));
        second.y = Math.max(second.size / 2 + 4, Math.min(WORLD_HEIGHT - second.size / 2 - 4, second.y));
      }
    }
  }
}

function matchSnapshot(room, playerId) {
  const player = room.players.get(playerId);
  return {
    matchId: room.matchId,
    elapsed: room.elapsed,
    round: room.round,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    selfId: playerId,
    self: player ? {
      x: player.x, y: player.y, vx: player.vx, vy: player.vy,
      hp: player.hp, maxHp: player.maxHp, invulnerable: player.invulnerable,
      shieldTimer: player.shieldTimer, abilityCooldown: player.abilityCooldown,
      effectTimer: player.effectTimer, abilityUsed: player.abilityUsed, cups: player.cups, alive: player.alive
    } : null,
    players: [...room.players.values()].map((entry) => ({
      id: entry.id, name: entry.name, color: entry.color, skin: entry.skin,
      x: entry.x, y: entry.y, hp: entry.hp, maxHp: entry.maxHp,
      shieldTimer: entry.shieldTimer, alive: entry.alive, cups: entry.cups
    })),
    enemies: room.enemies,
    pickups: room.pickups
  };
}

function broadcastSnapshots(room) {
  for (const player of room.players.values()) {
    if (player.connected) sendSocket(player.socket, "gameState", { state: matchSnapshot(room, player.id), serverTime: Date.now() });
  }
}

function checkMatchEnd(room) {
  if (room.phase !== "playing") return;
  const active = [...room.players.values()].filter((player) => player.alive);
  if (active.length > 1) return;
  const participants = [...room.players.values()].filter((player) => player.participated);
  const winner = active[0] || participants.sort((a, b) => b.survived - a.survived || b.cups - a.cups)[0] || null;
  finishMatch(room, winner);
}

function finishMatch(room, winner) {
  if (room.phase !== "playing") return;
  room.phase = "finished";
  const matchId = room.matchId;
  const results = [...room.players.values()].filter((player) => player.participated).map((player) => {
    const account = accounts.get(player.id);
    const alreadyRewarded = account.rewardedMatches.includes(matchId);
    const reward = alreadyRewarded ? 0 : player.cups;
    if (!alreadyRewarded) {
      account.rewardedMatches.push(matchId);
      account.rewardedMatches = account.rewardedMatches.slice(-1000);
      account.matches += 1;
      account.cups += player.cups;
      account.balance += reward;
      account.bestSurvival = Math.max(account.bestSurvival, player.survived, player.alive ? room.elapsed : 0);
      if (winner?.id === player.id) account.wins += 1;
    }
    return {
      playerId: player.id, name: player.name, survived: Math.floor(player.survived || (player.alive ? room.elapsed : 0)),
      cups: player.cups, reward, won: winner?.id === player.id, profile: publicProfile(account)
    };
  });
  persistAccounts();
  room.lastResult = {
    matchId,
    winner: winner ? { playerId: winner.id, name: winner.name } : null,
    elapsed: Math.floor(room.elapsed),
    results
  };
  broadcastRoom(room, "matchResult", room.lastResult);
  emitEvent(room, winner ? `Переміг ${winner.name}!` : "Матч завершився без переможця.");
  sendRoomState(room);
}

function tickRoom(room, dt) {
  if (room.phase !== "playing") {
    let changed = false;
    for (const player of room.players.values()) {
      if (player.connected || !player.disconnectedAt || Date.now() - player.disconnectedAt <= RECONNECT_GRACE_MS) continue;
      room.players.delete(player.id);
      const account = accounts.get(player.id);
      if (account) account.roomId = null;
      if (room.ownerId === player.id) room.ownerId = room.players.keys().next().value || null;
      changed = true;
    }
    if (changed && room.players.size) sendRoomState(room);
    if (!room.players.size) rooms.delete(room.code);
    return;
  }
  room.elapsed += dt;
  room.round = Math.floor(room.elapsed / 60) + 1;
  const difficulty = Math.pow(1.03, room.round - 1);
  for (const player of room.players.values()) {
    if (!player.alive) continue;
    if (!player.connected && Date.now() - player.disconnectedAt > RECONNECT_GRACE_MS) {
      player.alive = false;
      player.survived = room.elapsed;
      emitEvent(room, `${player.name} втратив з'єднання та вибув.`);
      continue;
    }
    player.abilityCooldown = Math.max(0, player.abilityCooldown - dt);
    player.effectTimer = Math.max(0, player.effectTimer - dt);
    player.shieldTimer = Math.max(0, player.shieldTimer - dt);
    player.invulnerable = Math.max(0, player.invulnerable - dt);
    const speed = 242 * (player.abilityUsed === "speed" && player.effectTimer > 0 ? 1.75 : 1);
    const acceleration = Math.min(1, dt * 12);
    player.vx += (player.inputX * speed - player.vx) * acceleration;
    player.vy += (player.inputY * speed - player.vy) * acceleration;
    if (!player.inputX && !player.inputY) {
      player.vx *= Math.max(0, 1 - dt * 8);
      player.vy *= Math.max(0, 1 - dt * 8);
    }
    player.x = Math.max(23, Math.min(WORLD_WIDTH - 23, player.x + player.vx * dt));
    player.y = Math.max(23, Math.min(WORLD_HEIGHT - 23, player.y + player.vy * dt));
    player.survived = room.elapsed;
  }
  room.enemyTimer -= dt;
  if (room.enemyTimer <= 0 && room.enemies.length < 14) {
    spawnEnemy(room);
    room.enemyTimer = 2.3;
  }
  updateEnemies(room, dt, difficulty);
  separateEnemies(room);
  for (const enemy of room.enemies) {
    for (const player of room.players.values()) {
      if (!player.alive) continue;
      const half = enemy.size / 2;
      const closestX = Math.max(enemy.x - half, Math.min(player.x, enemy.x + half));
      const closestY = Math.max(enemy.y - half, Math.min(player.y, enemy.y + half));
      if ((player.x - closestX) ** 2 + (player.y - closestY) ** 2 < 16 ** 2) hitPlayer(room, player, enemy);
    }
  }
  collectPickups(room, dt);
  checkMatchEnd(room);
  room.snapshotTimer += dt * 1000;
  if (room.snapshotTimer >= SNAPSHOT_MS) {
    room.snapshotTimer %= SNAPSHOT_MS;
    broadcastSnapshots(room);
  }
}

function createToken() {
  return randomBytes(32).toString("base64url");
}

async function handleHttp(request, response) {
  const origin = request.headers.origin || "";
  if (!validOrigin(origin)) return sendJson(response, 403, { error: "Доступ із цього сайту не дозволено." });
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin"
    });
    return response.end();
  }
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true });
  if (request.method === "GET" && url.pathname === "/api/leaderboard") return sendJson(response, 200, { leaderboard: getLeaderboard() }, origin);
  if (request.method === "POST" && url.pathname === "/api/session") {
    const ip = request.socket.remoteAddress || "unknown";
    const rate = sessionRateLimits.get(ip) || { startsAt: Date.now(), count: 0 };
    if (Date.now() - rate.startsAt >= 60_000) {
      rate.startsAt = Date.now();
      rate.count = 0;
    }
    rate.count += 1;
    sessionRateLimits.set(ip, rate);
    if (rate.count > 20) return sendJson(response, 429, { error: "Забагато спроб входу. Спробуй за хвилину." }, origin);
    try {
      const body = await readJson(request);
      let account = typeof body.playerId === "string" ? accounts.get(body.playerId) : null;
      if (account && tokenMatches(body.token, account.tokenHash)) {
        account.name = safeName(body.name || account.name);
        if (PLAYER_COLORS.has(body.color)) account.color = body.color;
      } else {
        const id = randomUUID();
        const token = createToken();
        account = {
          id, tokenHash: hashToken(token).toString("hex"), name: safeName(body.name),
          color: PLAYER_COLORS.has(body.color) ? body.color : "#68f1e2",
          balance: 0, ownedAbilities: [], equippedAbility: null, ownedSkins: ["classic"],
          selectedSkin: "classic", matches: 0, wins: 0, cups: 0, bestSurvival: 0,
          rewardedMatches: [], roomId: null
        };
        accounts.set(id, account);
        await persistAccounts();
        return sendJson(response, 201, { token: `${id}.${token}`, profile: publicProfile(account) }, origin);
      }
      await persistAccounts();
      return sendJson(response, 200, { token: `${account.id}.${body.token}`, profile: publicProfile(account) }, origin);
    } catch (error) {
      const status = error.message === "Request body is too large." ? 413 : 400;
      return sendJson(response, status, { error: "Не вдалося створити онлайн-профіль." }, origin);
    }
  }
  const account = authAccount(request);
  if (!account) return sendJson(response, 401, { error: "Онлайн-сесію не підтверджено." }, origin);
  if (request.method === "GET" && url.pathname === "/api/profile") return sendJson(response, 200, { profile: publicProfile(account) }, origin);
  if (request.method === "POST" && url.pathname === "/api/store") {
    try {
      const body = await readJson(request);
      if (body.action === "purchase") {
        const type = body.itemType;
        const itemId = body.itemId;
        const catalog = type === "ability"
          ? { dash: 50, shield: 100, magnet: 100, wave: 150, speed: 150, "extra-health": 200, "slow-time": 250, "double-cups": 300 }
          : type === "skin"
            ? { classic: 0, fire: 50, ice: 100, electric: 175, toxic: 250, ghost: 350, rainbow: 450, diamond: 600, "gold-king": 800, galactic: 1100, shadow: 1500, legendary: 2500 }
            : null;
        if (!catalog || !Object.hasOwn(catalog, itemId)) return sendJson(response, 400, { error: "Невідомий товар." }, origin);
        const owned = type === "ability" ? account.ownedAbilities : account.ownedSkins;
        if (!owned.includes(itemId)) {
          if (account.balance < catalog[itemId]) return sendJson(response, 409, { error: "Недостатньо онлайн-кубків." }, origin);
          account.balance -= catalog[itemId];
          owned.push(itemId);
        }
        if (type === "ability") account.equippedAbility = itemId;
        else account.selectedSkin = itemId;
      } else if (body.action === "equip") {
        if (body.itemType === "ability" && account.ownedAbilities.includes(body.itemId)) account.equippedAbility = body.itemId;
        else if (body.itemType === "skin" && account.ownedSkins.includes(body.itemId)) account.selectedSkin = body.itemId;
        else return sendJson(response, 409, { error: "Цей предмет ще не придбаний." }, origin);
      } else return sendJson(response, 400, { error: "Невідома дія магазину." }, origin);
      await persistAccounts();
      return sendJson(response, 200, { profile: publicProfile(account) }, origin);
    } catch {
      return sendJson(response, 400, { error: "Некоректний запит магазину." }, origin);
    }
  }
  return sendJson(response, 404, { error: "Маршрут не знайдено." }, origin);
}

export async function createGameServer({ port = Number(process.env.PORT) || 3000, host = process.env.HOST || "0.0.0.0", dataFile = DATA_FILE } = {}) {
  activeDataFile = dataFile;
  rooms.clear();
  accounts.clear();
  socketsByPlayer.clear();
  sessionRateLimits.clear();
  roomJoinLimits.clear();
  await loadAccounts();
  const server = createServer((request, response) => {
    void handleHttp(request, response);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin || "";
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/ws" || !validOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit("connection", webSocket, request));
  });
  wss.on("connection", (socket) => {
    socket.isAlive = true;
    socket.authenticatedPlayer = null;
    socket.messageTimes = [];
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (data) => {
      const now = Date.now();
      socket.messageTimes = socket.messageTimes.filter((time) => now - time < 1000);
      if (socket.messageTimes.length >= 35) {
        sendSocket(socket, "error", { message: "Забагато команд. Зачекай секунду." });
        return;
      }
      socket.messageTimes.push(now);
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        sendSocket(socket, "error", { message: "Некоректне повідомлення." });
        return;
      }
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        sendSocket(socket, "error", { message: "Некоректний формат повідомлення." });
        return;
      }
      if (message.type === "auth") {
        const account = accounts.get(message.playerId);
        if (!account || !tokenMatches(message.token, account.tokenHash)) {
          sendSocket(socket, "error", { message: "Не вдалося підтвердити онлайн-профіль." });
          socket.close(4003, "Authentication failed");
          return;
        }
        const previousSocket = socketsByPlayer.get(account.id);
        if (previousSocket && previousSocket !== socket) previousSocket.close(4001, "Reconnected elsewhere");
        socketsByPlayer.set(account.id, socket);
        socket.authenticatedPlayer = account.id;
        if (typeof message.profile?.name === "string") account.name = safeName(message.profile.name);
        if (PLAYER_COLORS.has(message.profile?.color)) account.color = message.profile.color;
        const room = roomByPlayer(account);
        if (room) {
          joinRoom(room, account, socket);
          if (room.phase === "playing") {
            sendSocket(socket, "matchStarted", { matchId: room.matchId, world: { width: WORLD_WIDTH, height: WORLD_HEIGHT }, startedAt: Date.now() - room.elapsed * 1000 });
            sendSocket(socket, "gameState", { state: matchSnapshot(room, account.id), serverTime: Date.now() });
          } else if (room.phase === "finished" && room.lastResult) sendSocket(socket, "matchResult", room.lastResult);
        }
        sendSocket(socket, "authenticated", { profile: publicProfile(account) });
        return;
      }
      const playerId = socket.authenticatedPlayer;
      const account = playerId ? accounts.get(playerId) : null;
      if (!account) {
        sendSocket(socket, "error", { message: "Спочатку підтверди онлайн-профіль." });
        return;
      }
      const room = roomByPlayer(account);
      if (message.type === "createRoom") {
        if (room) leaveRoom(account);
        const newRoom = makeRoom(account, true, socket);
        sendSocket(socket, "roomCreated", { code: newRoom.code });
      } else if (message.type === "quickJoin") {
        const target = [...rooms.values()].find((candidate) => !candidate.private && candidate.phase === "lobby" && candidate.players.size < MAX_PLAYERS && !candidate.players.has(account.id));
        if (target) joinRoom(target, account, socket);
        else makeRoom(account, false, socket);
      } else if (message.type === "joinRoom") {
        const code = typeof message.code === "string" ? message.code.trim().toUpperCase() : "";
        const target = rooms.get(code);
        const joinRate = roomJoinLimits.get(account.id) || { startsAt: Date.now(), count: 0 };
        if (Date.now() - joinRate.startsAt >= 60_000) {
          joinRate.startsAt = Date.now();
          joinRate.count = 0;
        }
        joinRate.count += 1;
        roomJoinLimits.set(account.id, joinRate);
        if (joinRate.count > 12) sendSocket(socket, "error", { message: "Забагато спроб. Спробуй знову за хвилину." });
        else if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code) || !target) sendSocket(socket, "error", { message: "Такої кімнати не знайдено. Перевір код." });
        else if (target.phase !== "lobby") sendSocket(socket, "error", { message: "Цей матч уже почався." });
        else if (target.players.size >= MAX_PLAYERS) sendSocket(socket, "error", { message: "Кімната заповнена (максимум 8 гравців)." });
        else joinRoom(target, account, socket);
      } else if (message.type === "ready") {
        if (!room || room.phase !== "lobby") return sendSocket(socket, "error", { message: "Зараз немає кімнати для готовності." });
        room.players.get(account.id).ready = message.ready === true;
        sendRoomState(room);
      } else if (message.type === "startMatch") {
        if (!room || room.ownerId !== account.id) return sendSocket(socket, "error", { message: "Почати матч може тільки власник кімнати." });
        if ([...room.players.values()].filter((player) => player.ready && player.connected).length < 2) return sendSocket(socket, "error", { message: "Потрібно щонайменше двоє готових гравців." });
        startMatch(room);
      } else if (message.type === "leaveRoom") {
        leaveRoom(account, "Гравець залишив кімнату");
        sendSocket(socket, "leftRoom");
      } else if (message.type === "input") {
        if (!room || room.phase !== "playing") return;
        const player = room.players.get(account.id);
        if (player) applyInput(player, message);
      } else if (message.type === "ability") {
        if (room?.phase === "playing") {
          const player = room.players.get(account.id);
          if (player) useAbility(room, player);
        }
      } else if (message.type === "profile") {
        account.name = safeName(message.name);
        if (PLAYER_COLORS.has(message.color)) account.color = message.color;
        const player = room?.players.get(account.id);
        if (player) { player.name = account.name; player.color = account.color; }
        persistAccounts();
        sendSocket(socket, "authenticated", { profile: publicProfile(account) });
        if (room) sendRoomState(room);
      } else if (message.type === "leaderboard") {
        sendSocket(socket, "leaderboard", { leaderboard: getLeaderboard() });
      } else {
        sendSocket(socket, "error", { message: "Невідома команда сервера." });
      }
    });
    socket.on("close", () => {
      const playerId = socket.authenticatedPlayer;
      if (!playerId || socketsByPlayer.get(playerId) !== socket) return;
      socketsByPlayer.delete(playerId);
      const account = accounts.get(playerId);
      const room = account && roomByPlayer(account);
      const player = room?.players.get(playerId);
      if (!player) return;
      player.connected = false;
      player.disconnectedAt = Date.now();
      player.inputX = 0;
      player.inputY = 0;
      sendRoomState(room);
    });
    socket.on("error", (error) => console.warn("WebSocket client error:", error.message));
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, 15_000);
  const ticker = setInterval(() => {
    const dt = TICK_MS / 1000;
    for (const room of rooms.values()) tickRoom(room, dt);
  }, TICK_MS);
  server.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(ticker);
    for (const socket of wss.clients) socket.terminate();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    wss,
    rooms,
    accounts,
    close: async () => {
      for (const room of rooms.values()) for (const player of room.players.values()) if (player.socket) player.socket.close();
      await new Promise((resolve) => server.close(resolve));
      await persistAccounts();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createGameServer().then((runtime) => {
    const { server } = runtime;
    const address = server.address();
    console.log(`Online arena server listening on http://${address.address}:${address.port}`);
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        runtime.close().then(() => {
          console.log("Online arena server stopped cleanly.");
        }).catch((error) => {
          console.error("Unable to stop the online arena cleanly:", error);
          process.exitCode = 1;
        });
      });
    }
  }).catch((error) => {
    console.error("Unable to start online arena server:", error);
    process.exitCode = 1;
  });
}
