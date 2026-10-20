"use strict";

const STORAGE_KEY = "nazarArenaProfile";
const DEFAULT_COLOR = "#68f1e2";
const COLORS = ["#68f1e2", "#ff67d8", "#ffc857", "#8c81ff", "#82f06a"];
const MAX_ENEMIES = 14;
const HIT_COOLDOWN = 0.7;
const PICKUP_LIMIT = 10;
const PICKUP_INTERVAL = 7;
const MOVEMENT_CODES = {
  KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d",
  ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright"
};
const ENEMY_TYPES = {
  normal: { size: 15, color: "#ff5f83", speed: 1, label: "звичайний" },
  fast: { size: 12, color: "#ffad5b", speed: 1.55, label: "швидкий" },
  big: { size: 22, color: "#a277ff", speed: 0.7, label: "великий" },
  dash: { size: 14, color: "#ff62d0", speed: 1.05, label: "ривковий" }
};

const dom = {
  screens: [...document.querySelectorAll("[data-screen]")],
  menu: document.querySelector('[data-screen="menu"]'),
  game: document.querySelector('[data-screen="game"]'),
  canvas: document.querySelector("#arena"),
  ctx: document.querySelector("#arena").getContext("2d"),
  minimap: document.querySelector("#minimap"),
  minimapCtx: document.querySelector("#minimap").getContext("2d"),
  overlay: document.querySelector("[data-overlay]"),
  toast: document.querySelector("[data-toast]"),
  nameInput: document.querySelector("#player-name"),
  nameFeedback: document.querySelector("#name-feedback"),
  settingsName: document.querySelector("#settings-name"),
  settingsFeedback: document.querySelector("[data-settings-feedback]"),
  modalBackdrop: document.querySelector("[data-modal-backdrop]"),
  joystick: document.querySelector("[data-joystick]"),
  joystickKnob: document.querySelector("[data-joystick-knob]")
};

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      name: typeof saved.name === "string" && saved.name.trim() ? limitName(saved.name.trim()) : "Шарік",
      color: COLORS.includes(saved.color) ? saved.color : DEFAULT_COLOR,
      trophies: Number.isSafeInteger(saved.trophies) && saved.trophies >= 0 ? saved.trophies : 0,
      bestTime: Number.isFinite(saved.bestTime) && saved.bestTime >= 0 ? saved.bestTime : 0,
      sound: saved.sound !== false
    };
  } catch (error) {
    console.warn("Не вдалося прочитати збережені дані арени.", error);
    return { name: "Шарік", color: DEFAULT_COLOR, trophies: 0, bestTime: 0, sound: true };
  }
}

const profile = loadProfile();
const game = {
  state: "menu",
  player: { x: 0, y: 0, vx: 0, vy: 0, radius: 16, hp: 3, invulnerable: 0 },
  enemies: [],
  pickups: [],
  particles: [],
  elapsed: 0,
  runTrophies: 0,
  spawnTimer: 1.8,
  pickupTimer: 2,
  keys: new Set(),
  joystick: { active: false, pointerId: null, x: 0, y: 0 },
  width: 0,
  height: 0,
  worldWidth: 0,
  worldHeight: 0,
  cameraX: 0,
  cameraY: 0,
  lastFrame: 0,
  toastTimer: 0,
  audio: null
};

function saveProfile() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch (error) {
    console.error("Не вдалося зберегти прогрес арени.", error);
    showToast("Не вдалося зберегти прогрес");
  }
  updateProfileUI();
}

function updateProfileUI() {
  document.querySelectorAll("[data-total-trophies]").forEach((node) => { node.textContent = String(profile.trophies); });
  document.querySelectorAll("[data-best-time]").forEach((node) => { node.textContent = formatTime(profile.bestTime); });
  document.querySelectorAll(".color-swatch").forEach((swatch) => {
    const selected = swatch.dataset.color === profile.color;
    swatch.classList.toggle("is-selected", selected);
    swatch.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-player-avatar]").forEach((avatar) => {
    avatar.textContent = [...profile.name][0]?.toLocaleUpperCase("uk") || "Ш";
    avatar.style.setProperty("--player-color", profile.color);
  });
  const soundButton = document.querySelector('[data-action="toggle-sound"]');
  if (soundButton) {
    soundButton.setAttribute("aria-pressed", String(profile.sound));
    soundButton.querySelector("span").textContent = profile.sound ? "УВІМКНЕНО" : "ВИМКНЕНО";
  }
  const hudName = document.querySelector("[data-hud-name]");
  if (hudName) hudName.textContent = profile.name;
}

function setNameFrom(input, feedback) {
  const name = limitName(input.value.trim());
  if (!name) {
    feedback.textContent = "Введи ім'я (до 16 символів).";
    input.focus();
    return false;
  }
  profile.name = name;
  input.value = name;
  dom.nameInput.value = name;
  dom.settingsName.value = name;
  dom.nameFeedback.textContent = "";
  dom.settingsFeedback.textContent = "";
  saveProfile();
  if (game.state === "playing" || game.state === "paused") showToast(`Тепер ти — ${profile.name}!`);
  return true;
}

function setColor(color) {
  if (!COLORS.includes(color)) return;
  profile.color = color;
  saveProfile();
}

function showScreen(screen) {
  dom.screens.forEach((node) => node.classList.toggle("is-hidden", node !== screen));
}

function openModal(name) {
  dom.modalBackdrop.classList.remove("is-hidden");
  document.querySelectorAll("[data-modal]").forEach((modal) => {
    modal.classList.toggle("is-hidden", modal.dataset.modal !== name);
  });
  if (name === "settings") dom.settingsName.value = profile.name;
  const firstButton = document.querySelector(`[data-modal="${name}"] button`);
  firstButton?.focus();
}

function closeModal() {
  dom.modalBackdrop.classList.add("is-hidden");
  document.querySelectorAll("[data-modal]").forEach((modal) => modal.classList.add("is-hidden"));
}

function setGameState(state) {
  game.state = state;
  updateHud();
}

function beginRun() {
  closeModal();
  game.runTrophies = 0;
  game.particles = [];
  game.enemies = [];
  game.pickups = [];
  game.elapsed = 0;
  game.spawnTimer = 1.4;
  game.pickupTimer = 1;
  game.keys.clear();
  game.player.hp = 3;
  game.player.vx = 0;
  game.player.vy = 0;
  game.player.invulnerable = 0;
  showScreen(dom.game);
  resizeCanvas();
  dom.canvas.focus({ preventScroll: true });
  const center = arenaCenter();
  game.player.x = center.x;
  game.player.y = center.y;
  updateCamera();
  for (let i = 0; i < 3; i += 1) spawnPickup();
  for (let i = 0; i < 2; i += 1) spawnEnemy();
  setGameState("playing");
  game.lastFrame = performance.now();
  updateHud();
  requestAnimationFrame(gameLoop);
  playSound("start");
}

function getDifficulty() {
  const minutes = Math.floor(game.elapsed / 60);
  return {
    minutes,
    speed: Math.pow(1.03, minutes),
    maxEnemies: MAX_ENEMIES,
    spawnInterval: 2.3
  };
}

function chooseEnemyType() {
  const minutes = Math.floor(game.elapsed / 60);
  const roll = Math.random();
  if (minutes >= 6 && roll < .2) return "dash";
  if (minutes >= 4 && roll < .42) return "big";
  if (minutes >= 2 && roll < .72) return "fast";
  return "normal";
}

function arenaCenter() {
  return { x: game.worldWidth / 2 || 1, y: game.worldHeight / 2 || 1 };
}

function spawnEnemy() {
  if (game.enemies.length >= getDifficulty().maxEnemies) return;
  const type = chooseEnemyType();
  const spec = ENEMY_TYPES[type];
  const padding = spec.size + 10;
  const minPlayerDistance = Math.min(160, Math.min(game.width, game.height) * .42);
  let x = game.player.x;
  let y = game.player.y;
  let bestScore = -Infinity;
  let bestPosition = { x, y };
  for (let i = 0; i < 30; i += 1) {
    const edge = Math.floor(Math.random() * 4);
    x = edge < 2
      ? game.cameraX + padding + Math.random() * Math.max(1, game.width - padding * 2)
      : Math.random() * (game.worldWidth - padding * 2) + padding;
    y = edge >= 2
      ? game.cameraY + padding + Math.random() * Math.max(1, game.height - padding * 2)
      : Math.random() * (game.worldHeight - padding * 2) + padding;
    x = clamp(x, padding, game.worldWidth - padding);
    y = clamp(y, padding, game.worldHeight - padding);
    const playerDistance = Math.hypot(x - game.player.x, y - game.player.y);
    const nearestEnemyGap = game.enemies.reduce((gap, enemy) => Math.min(
      gap,
      Math.hypot(x - enemy.x, y - enemy.y) - (spec.size + enemy.size) / 2 - 2
    ), Infinity);
    const score = Math.min(playerDistance - minPlayerDistance, nearestEnemyGap);
    if (score > bestScore) {
      bestScore = score;
      bestPosition = { x, y };
    }
    if (score >= 0) break;
  }
  ({ x, y } = bestPosition);
  game.enemies.push({
    type, x, y, vx: 0, vy: 0, size: spec.size,
    speed: 58 * spec.speed,
    color: spec.color,
    dashCooldown: 2.2 + Math.random() * 2,
    dashTime: 0,
    dashX: 0,
    dashY: 0,
    hitFlash: 0,
    phase: Math.random() * Math.PI * 2
  });
}

function spawnPickup() {
  if (game.pickups.length >= PICKUP_LIMIT || !game.worldWidth || !game.worldHeight) return;
  const radius = 11;
  const padding = radius + 12;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 32; i += 1) {
    const x = clamp(
      game.cameraX + 35 + Math.random() * Math.max(1, game.width - 70),
      padding,
      game.worldWidth - padding
    );
    const y = clamp(
      game.cameraY + 35 + Math.random() * Math.max(1, game.height - 70),
      padding,
      game.worldHeight - padding
    );
    const distanceFromPlayer = Math.hypot(x - game.player.x, y - game.player.y);
    const nearestEnemyGap = game.enemies.reduce((gap, enemy) => Math.min(
      gap,
      Math.hypot(x - enemy.x, y - enemy.y) - enemy.size / 2 - radius
    ), Infinity);
    const nearestPickupGap = game.pickups.reduce((gap, pickup) => Math.min(
      gap,
      Math.hypot(x - pickup.x, y - pickup.y) - radius - pickup.radius
    ), Infinity);
    const score = Math.min(distanceFromPlayer - 75, nearestEnemyGap, nearestPickupGap);
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
    if (score >= 3) break;
  }
  if (!best) return;
  game.pickups.push({ x: best.x, y: best.y, radius, phase: Math.random() * Math.PI * 2 });
}

function awardTrophies(amount, reason) {
  if (amount <= 0) return;
  game.runTrophies += amount;
  profile.trophies += amount;
  saveProfile();
  showToast(`+${amount} 🏆  ${reason}`);
  playSound("trophy");
}

function gameOver() {
  if (game.state !== "playing") return;
  if (game.elapsed > profile.bestTime) {
    profile.bestTime = game.elapsed;
    saveProfile();
  }
  setGameState("gameover");
  game.keys.clear();
  resetJoystick();
  const elapsed = formatTime(game.elapsed);
  showOverlay({
    icon: "💥",
    kicker: "ЗАБІГ ЗАВЕРШЕНО",
    title: "ТЕБЕ СПІЙМАЛИ!",
    message: `${profile.name} протримався ${elapsed} у «Круг проти квадратів»!`,
    summary: `ЗАБІГ: ${game.runTrophies} 🏆 · УСЬОГО: ${profile.trophies} 🏆<br>РЕКОРД ЧАСУ: ${formatTime(profile.bestTime)}`,
    actions: [
      { label: "ГРАТИ ЩЕ РАЗ", action: "restart", primary: true },
      { label: "ГОЛОВНЕ МЕНЮ", action: "menu", secondary: true }
    ]
  });
  playSound("death");
}

function pauseGame() {
  if (game.state !== "playing") return;
  setGameState("paused");
  game.keys.clear();
  resetJoystick();
  showOverlay({
    icon: "Ⅱ", kicker: `В АРЕНІ ${formatTime(game.elapsed)}`,
    title: "ПАУЗА", message: "Квадрати теж видихають. Але недовго.",
    actions: [
      { label: "ПРОДОВЖИТИ", action: "resume", primary: true },
      { label: "ПОЧАТИ ЗАНОВО", action: "restart", secondary: true },
      { label: "ГОЛОВНЕ МЕНЮ", action: "menu", secondary: true }
    ]
  });
}

function resumeGame() {
  if (game.state !== "paused") return;
  dom.overlay.classList.add("is-hidden");
  setGameState("playing");
  game.lastFrame = performance.now();
  requestAnimationFrame(gameLoop);
}

function showOverlay({ icon = "🏆", kicker = "", title = "", message = "", summary = "", actions = [] }) {
  dom.overlay.replaceChildren();
  const card = document.createElement("section");
  card.className = "overlay-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  const iconNode = document.createElement("div");
  iconNode.className = "overlay-icon";
  iconNode.textContent = icon;
  const kickerNode = document.createElement("div");
  kickerNode.className = "overlay-kicker";
  kickerNode.textContent = kicker;
  const titleNode = document.createElement("h2");
  titleNode.textContent = title;
  const messageNode = document.createElement("p");
  messageNode.textContent = message;
  card.append(iconNode, kickerNode, titleNode, messageNode);
  if (summary) {
    const summaryNode = document.createElement("p");
    summaryNode.className = "overlay-summary";
    summaryNode.innerHTML = summary;
    card.append(summaryNode);
  }
  const actionRow = document.createElement("div");
  actionRow.className = "overlay-actions";
  actions.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${item.primary ? "button-play" : "overlay-secondary"}${item.danger ? " overlay-danger" : ""}`;
    button.dataset.action = item.action;
    button.textContent = item.label;
    actionRow.append(button);
  });
  card.append(actionRow);
  dom.overlay.append(card);
  dom.overlay.classList.remove("is-hidden");
  card.querySelector("button")?.focus();
}

function updateGame(dt) {
  if (game.state !== "playing") return;
  game.elapsed += dt;
  const difficulty = getDifficulty();
  const p = game.player;
  let inputX = 0;
  let inputY = 0;
  if (game.keys.has("a") || game.keys.has("arrowleft")) inputX -= 1;
  if (game.keys.has("d") || game.keys.has("arrowright")) inputX += 1;
  if (game.keys.has("w") || game.keys.has("arrowup")) inputY -= 1;
  if (game.keys.has("s") || game.keys.has("arrowdown")) inputY += 1;
  inputX += game.joystick.x;
  inputY += game.joystick.y;
  const inputLength = Math.hypot(inputX, inputY);
  if (inputLength > 1) { inputX /= inputLength; inputY /= inputLength; }
  const playerSpeed = 242;
  const acceleration = Math.min(1, dt * 12);
  p.vx += (inputX * playerSpeed - p.vx) * acceleration;
  p.vy += (inputY * playerSpeed - p.vy) * acceleration;
  if (inputLength === 0) {
    p.vx *= Math.max(0, 1 - dt * 8);
    p.vy *= Math.max(0, 1 - dt * 8);
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.x = clamp(p.x, p.radius + 7, Math.max(p.radius + 7, game.worldWidth - p.radius - 7));
  p.y = clamp(p.y, p.radius + 7, Math.max(p.radius + 7, game.worldHeight - p.radius - 7));
  p.invulnerable = Math.max(0, p.invulnerable - dt);
  updateCamera();

  game.spawnTimer -= dt;
  if (game.spawnTimer <= 0 && game.enemies.length < difficulty.maxEnemies) {
    spawnEnemy();
    game.spawnTimer = difficulty.spawnInterval;
  }
  game.pickupTimer -= dt;
  if (game.pickupTimer <= 0) {
    spawnPickup();
    game.pickupTimer = PICKUP_INTERVAL;
  }

  let hitEnemy = null;
  for (const enemy of game.enemies) {
    updateEnemy(enemy, dt, difficulty);
  }
  separateEnemies();
  for (const enemy of game.enemies) {
    if (p.invulnerable <= 0 && collidesCircleSquare(p.x, p.y, p.radius, enemy.x, enemy.y, enemy.size)) {
      hitEnemy = enemy;
      break;
    }
  }
  if (hitEnemy) takeDamage(hitEnemy);
  for (let i = game.pickups.length - 1; i >= 0; i -= 1) {
    const pickup = game.pickups[i];
    pickup.phase += dt * 3.5;
    if (Math.hypot(p.x - pickup.x, p.y - pickup.y) <= p.radius + pickup.radius) {
      game.pickups.splice(i, 1);
      awardTrophies(1, "кубок зібрано");
      makeBurst(pickup.x, pickup.y, "#ffc857", 14);
    }
  }
  updateParticles(dt);
  game.toastTimer = Math.max(0, game.toastTimer - dt);
  if (game.toastTimer === 0) dom.toast.textContent = "";
  updateHud();
}

function updateEnemy(enemy, dt, difficulty) {
  const dx = game.player.x - enemy.x;
  const dy = game.player.y - enemy.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const dirX = dx / distance;
  const dirY = dy / distance;
  if (enemy.type === "dash") {
    enemy.dashCooldown -= dt;
    enemy.dashTime = Math.max(0, enemy.dashTime - dt);
    if (enemy.dashCooldown <= 0) {
      enemy.dashTime = .52;
      enemy.dashCooldown = 3.5 + Math.random() * .7;
      enemy.dashX = dirX;
      enemy.dashY = dirY;
    }
  }
  const topSpeed = enemy.speed * difficulty.speed * (enemy.type === "dash" && enemy.dashTime > 0 ? 2.15 : 1);
  const steer = Math.min(1, dt * 3.1);
  const targetX = enemy.type === "dash" && enemy.dashTime > 0 ? enemy.dashX * topSpeed : dirX * topSpeed;
  const targetY = enemy.type === "dash" && enemy.dashTime > 0 ? enemy.dashY * topSpeed : dirY * topSpeed;
  enemy.vx += (targetX - enemy.vx) * steer;
  enemy.vy += (targetY - enemy.vy) * steer;
  enemy.x += enemy.vx * dt;
  enemy.y += enemy.vy * dt;
  enemy.x = clamp(enemy.x, enemy.size / 2 + 4, game.worldWidth - enemy.size / 2 - 4);
  enemy.y = clamp(enemy.y, enemy.size / 2 + 4, game.worldHeight - enemy.size / 2 - 4);
  enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
  enemy.phase += dt * 2;
}

function separateEnemies() {
  for (let pass = 0; pass < 12; pass += 1) {
    for (let i = 0; i < game.enemies.length; i += 1) {
      const first = game.enemies[i];
      for (let j = i + 1; j < game.enemies.length; j += 1) {
        const second = game.enemies[j];
        let dx = second.x - first.x;
        let dy = second.y - first.y;
        let distance = Math.hypot(dx, dy);
        const requiredDistance = (first.size + second.size) / 2 + 2;
        if (distance >= requiredDistance) continue;
        if (distance < .001) {
          const angle = (i * 2.399 + j * 1.618) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const overlap = requiredDistance - distance;
        const pushX = dx / distance * overlap * .55;
        const pushY = dy / distance * overlap * .55;
        first.x -= pushX;
        first.y -= pushY;
        second.x += pushX;
        second.y += pushY;
        const relativeSpeed = (second.vx - first.vx) * dx / distance + (second.vy - first.vy) * dy / distance;
        if (relativeSpeed < 0) {
          const impulse = -relativeSpeed * .52;
          first.vx -= dx / distance * impulse;
          first.vy -= dy / distance * impulse;
          second.vx += dx / distance * impulse;
          second.vy += dy / distance * impulse;
        }
        first.x = clamp(first.x, first.size / 2 + 4, game.worldWidth - first.size / 2 - 4);
        first.y = clamp(first.y, first.size / 2 + 4, game.worldHeight - first.size / 2 - 4);
        second.x = clamp(second.x, second.size / 2 + 4, game.worldWidth - second.size / 2 - 4);
        second.y = clamp(second.y, second.size / 2 + 4, game.worldHeight - second.size / 2 - 4);
      }
    }
  }
}

function collidesCircleSquare(cx, cy, radius, sx, sy, size) {
  const half = size / 2;
  const closestX = clamp(cx, sx - half, sx + half);
  const closestY = clamp(cy, sy - half, sy + half);
  return (cx - closestX) ** 2 + (cy - closestY) ** 2 < radius ** 2;
}

function takeDamage(enemy) {
  const p = game.player;
  p.hp -= 1;
  p.invulnerable = HIT_COOLDOWN;
  const dx = p.x - enemy.x;
  const dy = p.y - enemy.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  p.vx = (dx / length) * 270;
  p.vy = (dy / length) * 270;
  enemy.vx -= (dx / length) * 75;
  enemy.vy -= (dy / length) * 75;
  enemy.hitFlash = .2;
  makeBurst(p.x, p.y, "#ff607d", 18);
  playSound("hit");
  if (p.hp <= 0) {
    p.hp = 0;
    updateHud();
    gameOver();
  } else {
    showToast("ОЙ! ЩЕ ОДИН УДАР — І ГЕЙМ ОВЕР");
  }
}

function updateParticles(dt) {
  for (let i = game.particles.length - 1; i >= 0; i -= 1) {
    const particle = game.particles[i];
    particle.life -= dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= Math.max(0, 1 - dt * 2);
    particle.vy *= Math.max(0, 1 - dt * 2);
    if (particle.life <= 0) game.particles.splice(i, 1);
  }
}

function makeBurst(x, y, color, count = 10) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 35 + Math.random() * 160;
    game.particles.push({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: .3 + Math.random() * .42, maxLife: .72, size: 2 + Math.random() * 3, color
    });
  }
}

function drawGame() {
  const ctx = dom.ctx;
  const width = game.width;
  const height = game.height;
  if (!width || !height) return;
  updateCamera();
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#111a35");
  gradient.addColorStop(1, "#0c142b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  drawArenaGrid(ctx, width, height);
  for (const enemy of game.enemies) {
    const screenX = enemy.x - game.cameraX;
    const screenY = enemy.y - game.cameraY;
    if (screenX + enemy.size < 0 || screenX - enemy.size > width || screenY + enemy.size < 0 || screenY - enemy.size > height) continue;
    drawEnemy(ctx, enemy, screenX, screenY);
  }
  game.pickups.forEach((pickup) => {
    const screenX = pickup.x - game.cameraX;
    const screenY = pickup.y - game.cameraY;
    if (screenX + 20 < 0 || screenX - 20 > width || screenY + 20 < 0 || screenY - 20 > height) return;
    drawPickup(ctx, pickup, screenX, screenY);
  });
  game.particles.forEach((particle) => {
    const screenX = particle.x - game.cameraX;
    const screenY = particle.y - game.cameraY;
    ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(screenX, screenY, particle.size, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  drawPlayer(ctx, game.player.x - game.cameraX, game.player.y - game.cameraY);
  drawMinimap();
}

function updateCamera() {
  game.cameraX = clamp(game.player.x - game.width / 2, 0, Math.max(0, game.worldWidth - game.width));
  game.cameraY = clamp(game.player.y - game.height / 2, 0, Math.max(0, game.worldHeight - game.height));
}

function drawArenaGrid(ctx, width, height) {
  ctx.save();
  ctx.strokeStyle = "rgba(111,151,204,.075)";
  ctx.lineWidth = 1;
  const spacing = 36;
  const offsetX = ((-game.cameraX + game.elapsed * 2) % spacing + spacing) % spacing;
  const offsetY = ((-game.cameraY + game.elapsed * 2) % spacing + spacing) % spacing;
  for (let x = offsetX; x < width; x += spacing) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = offsetY; y < height; y += spacing) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(104,241,226,.24)";
  ctx.lineWidth = 2;
  if (game.cameraX === 0) { ctx.beginPath(); ctx.moveTo(4, 4); ctx.lineTo(4, height - 4); ctx.stroke(); }
  if (game.cameraX + width >= game.worldWidth) { ctx.beginPath(); ctx.moveTo(width - 4, 4); ctx.lineTo(width - 4, height - 4); ctx.stroke(); }
  if (game.cameraY === 0) { ctx.beginPath(); ctx.moveTo(4, 4); ctx.lineTo(width - 4, 4); ctx.stroke(); }
  if (game.cameraY + height >= game.worldHeight) { ctx.beginPath(); ctx.moveTo(4, height - 4); ctx.lineTo(width - 4, height - 4); ctx.stroke(); }
  ctx.restore();
}

function drawMinimap() {
  const canvas = dom.minimap;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !game.worldWidth || !game.worldHeight) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = rect.width;
  const height = rect.height;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = dom.minimapCtx;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(13,23,43,.94)";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(104,241,226,.6)";
  ctx.lineWidth = 1;
  ctx.strokeRect(.5, .5, width - 1, height - 1);
  const scaleX = width / game.worldWidth;
  const scaleY = height / game.worldHeight;
  ctx.fillStyle = "rgba(104,241,226,.12)";
  ctx.fillRect(game.cameraX * scaleX, game.cameraY * scaleY, game.width * scaleX, game.height * scaleY);
  for (const enemy of game.enemies) {
    ctx.fillStyle = enemy.color;
    ctx.fillRect(enemy.x * scaleX - 1, enemy.y * scaleY - 1, 3, 3);
  }
  for (const pickup of game.pickups) {
    ctx.fillStyle = "#ffc857";
    ctx.beginPath();
    ctx.arc(pickup.x * scaleX, pickup.y * scaleY, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = profile.color;
  ctx.beginPath();
  ctx.arc(game.player.x * scaleX, game.player.y * scaleY, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawPickup(ctx, pickup, x, y) {
  const bob = Math.sin(pickup.phase) * 2;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.shadowColor = "#ffc857";
  ctx.shadowBlur = 17;
  ctx.fillStyle = "rgba(255,200,87,.2)";
  ctx.beginPath();
  ctx.arc(0, 0, pickup.radius + 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 9;
  ctx.strokeStyle = "#ffe59a";
  ctx.fillStyle = "#ffc857";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-7, -7);
  ctx.lineTo(7, -7);
  ctx.lineTo(5, 1);
  ctx.quadraticCurveTo(0, 7, -5, 1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-7, -3, 4, Math.PI * .5, Math.PI * 1.5);
  ctx.arc(7, -3, 4, -Math.PI * .5, Math.PI * .5);
  ctx.stroke();
  ctx.shadowBlur = 4;
  ctx.fillStyle = "#fff1bc";
  ctx.fillRect(-1, 2, 2, 4);
  ctx.fillRect(-4, 7, 8, 2);
  ctx.restore();
}

function drawEnemy(ctx, enemy, x = enemy.x, y = enemy.y) {
  const half = enemy.size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(enemy.phase) * .08);
  ctx.shadowColor = enemy.color;
  ctx.shadowBlur = enemy.type === "dash" && enemy.dashTime > 0 ? 25 : 12;
  ctx.fillStyle = enemy.hitFlash > 0 ? "#fff" : enemy.color;
  roundRect(ctx, -half, -half, enemy.size, enemy.size, enemy.type === "big" ? 5 : 3);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,.45)";
  ctx.lineWidth = 1;
  roundRect(ctx, -half + 2, -half + 2, enemy.size - 4, enemy.size - 4, 2);
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(ctx, x = game.player.x, y = game.player.y) {
  const p = game.player;
  if (p.invulnerable > 0 && Math.floor(p.invulnerable * 14) % 2 === 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = p.invulnerable > 0 ? "#ff596f" : profile.color;
  ctx.shadowBlur = 24;
  const gradient = ctx.createRadialGradient(-5, -7, 2, 0, 0, p.radius);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(.2, profile.color);
  gradient.addColorStop(1, shadeColor(profile.color, -38));
  ctx.fillStyle = p.invulnerable > 0 ? "#ff596f" : gradient;
  ctx.beginPath();
  ctx.arc(0, 0, p.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,.75)";
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.fillStyle = "rgba(10,18,38,.75)";
  ctx.beginPath(); ctx.arc(-5, -2, 2, 0, Math.PI * 2); ctx.arc(5, -2, 2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(10,18,38,.8)";
  ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 2, 4, .2, Math.PI - .2); ctx.stroke();

  const name = profile.name;
  const fontSize = clamp(13 - Math.max(0, name.length - 7) * .45, 8, 13);
  ctx.font = `700 ${fontSize}px Manrope, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(5,8,20,.95)";
  ctx.strokeText(name, 0, -p.radius - 7, 150);
  ctx.fillStyle = "#fff";
  ctx.fillText(name, 0, -p.radius - 7, 150);
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function gameLoop(timestamp) {
  if (game.state !== "playing") return;
  const dt = Math.min(Math.max((timestamp - game.lastFrame) / 1000, 0), .05);
  game.lastFrame = timestamp;
  updateGame(dt);
  drawGame();
  if (game.state === "playing") requestAnimationFrame(gameLoop);
}

function updateHud() {
  const time = document.querySelector("[data-hud-time]");
  if (time) time.textContent = formatTime(game.elapsed);
  const hp = document.querySelector("[data-hud-hp]");
  if (hp) {
    hp.textContent = `${"♥".repeat(game.player.hp)}${"♡".repeat(3 - game.player.hp)}`;
    hp.setAttribute("aria-label", `Здоров'я: ${game.player.hp} з 3`);
  }
  const runCups = document.querySelector("[data-hud-run-cups]");
  if (runCups) runCups.textContent = String(game.runTrophies);
  const total = document.querySelector("[data-hud-total-cups]");
  if (total) total.textContent = String(profile.trophies);
  const speed = document.querySelector("[data-hud-speed]");
  const speedPercent = Math.round(getDifficulty().speed * 100);
  if (speed) speed.textContent = `${speedPercent}%`;
  const meter = document.querySelector("[data-difficulty-meter]");
  if (meter) meter.style.width = `${Math.min(100, Math.max(8, (speedPercent - 100) / 4))}%`;
  const label = document.querySelector("[data-difficulty-label]");
  if (label) label.textContent = `+${speedPercent - 100}% ЗАБІГ`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function limitName(value) {
  return Array.from(value).slice(0, 16).join("");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shadeColor(hex, amount) {
  const num = Number.parseInt(hex.slice(1), 16);
  const r = clamp((num >> 16) + amount, 0, 255);
  const g = clamp(((num >> 8) & 0xff) + amount, 0, 255);
  const b = clamp((num & 0xff) + amount, 0, 255);
  return `rgb(${r},${g},${b})`;
}

function showToast(message) {
  dom.toast.textContent = message;
  game.toastTimer = 2;
}

function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const previousWidth = game.width;
  const previousHeight = game.height;
  const previousWorldWidth = game.worldWidth;
  const previousWorldHeight = game.worldHeight;
  game.width = rect.width;
  game.height = rect.height;
  game.worldWidth = game.width * 4;
  game.worldHeight = game.height * 4;
  dom.canvas.width = Math.round(rect.width * ratio);
  dom.canvas.height = Math.round(rect.height * ratio);
  dom.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (!previousWidth || !previousHeight) {
    game.player.x = game.worldWidth / 2;
    game.player.y = game.worldHeight / 2;
  } else {
    game.player.x = game.player.x / previousWorldWidth * game.worldWidth;
    game.player.y = game.player.y / previousWorldHeight * game.worldHeight;
    game.enemies.forEach((enemy) => {
      enemy.x = enemy.x / previousWorldWidth * game.worldWidth;
      enemy.y = enemy.y / previousWorldHeight * game.worldHeight;
    });
    game.particles.forEach((particle) => {
      particle.x = particle.x / previousWorldWidth * game.worldWidth;
      particle.y = particle.y / previousWorldHeight * game.worldHeight;
    });
  }
  drawGame();
}

function resetJoystick() {
  game.joystick.active = false;
  game.joystick.pointerId = null;
  game.joystick.x = 0;
  game.joystick.y = 0;
  dom.joystickKnob.style.transform = "translate(0, 0)";
}

function handleJoystickDown(event) {
  if (!["playing"].includes(game.state)) return;
  event.preventDefault();
  game.joystick.active = true;
  game.joystick.pointerId = event.pointerId;
  dom.joystick.setPointerCapture(event.pointerId);
  moveJoystick(event);
}

function moveJoystick(event) {
  if (!game.joystick.active || event.pointerId !== game.joystick.pointerId) return;
  const rect = dom.joystick.querySelector(".joystick-ring").getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const max = rect.width * .34;
  const dx = event.clientX - centerX;
  const dy = event.clientY - centerY;
  const distance = Math.hypot(dx, dy);
  const scale = distance > max ? max / distance : 1;
  const knobX = dx * scale;
  const knobY = dy * scale;
  game.joystick.x = knobX / max;
  game.joystick.y = knobY / max;
  dom.joystickKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;
}

function playSound(type) {
  if (!profile.sound) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    game.audio ||= new AudioContextClass();
    if (game.audio.state === "suspended") game.audio.resume();
    const now = game.audio.currentTime;
    const oscillator = game.audio.createOscillator();
    const gain = game.audio.createGain();
    const settings = {
      hit: [180, 85, .14, "sawtooth"],
      trophy: [620, 920, .18, "sine"],
      death: [300, 70, .42, "sawtooth"],
      start: [360, 540, .12, "sine"]
    }[type];
    if (!settings) return;
    oscillator.type = settings[3];
    oscillator.frequency.setValueAtTime(settings[0], now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, settings[1]), now + settings[2]);
    gain.gain.setValueAtTime(.0001, now);
    gain.gain.exponentialRampToValueAtTime(.075, now + .015);
    gain.gain.exponentialRampToValueAtTime(.0001, now + settings[2]);
    oscillator.connect(gain);
    gain.connect(game.audio.destination);
    oscillator.start(now);
    oscillator.stop(now + settings[2] + .01);
  } catch (error) {
    console.warn("Не вдалося відтворити звуковий ефект.", error);
  }
}

function goToMenu() {
  closeModal();
  dom.overlay.classList.add("is-hidden");
  setGameState("menu");
  game.keys.clear();
  game.enemies = [];
  game.particles = [];
  resetJoystick();
  showScreen(dom.menu);
  updateProfileUI();
}

document.addEventListener("click", (event) => {
  const actionNode = event.target.closest("[data-action]");
  if (actionNode) {
    const action = actionNode.dataset.action;
    if (action === "play" || action === "restart") beginRun();
    else if (action === "show-how") openModal("how");
    else if (action === "show-settings") openModal("settings");
    else if (action === "close-modal") closeModal();
    else if (action === "save-name") {
      const settingsVisible = !document.querySelector('[data-modal="settings"]').classList.contains("is-hidden");
      const input = settingsVisible ? dom.settingsName : dom.nameInput;
      const feedback = settingsVisible ? dom.settingsFeedback : dom.nameFeedback;
      setNameFrom(input, feedback);
    } else if (action === "toggle-sound") {
      profile.sound = !profile.sound;
      saveProfile();
      if (profile.sound) playSound("start");
    } else if (action === "pause") pauseGame();
    else if (action === "resume") resumeGame();
    else if (action === "menu") goToMenu();
    return;
  }
  const swatch = event.target.closest("[data-color]");
  if (swatch) setColor(swatch.dataset.color);
  if (event.target === dom.modalBackdrop) closeModal();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!dom.modalBackdrop.classList.contains("is-hidden")) closeModal();
    else if (game.state === "playing") pauseGame();
    else if (game.state === "paused") resumeGame();
  }
  const key = MOVEMENT_CODES[event.code] || event.key.toLowerCase();
  if (game.state !== "playing") return;
  if (Object.values(MOVEMENT_CODES).includes(key)) {
    event.preventDefault();
    game.keys.add(key);
  }
}, true);

window.addEventListener("keyup", (event) => {
  const key = MOVEMENT_CODES[event.code] || event.key.toLowerCase();
  game.keys.delete(key);
}, true);
for (const input of [dom.nameInput, dom.settingsName]) {
  input.addEventListener("input", () => {
    const limited = limitName(input.value);
    if (input.value !== limited) input.value = limited;
  });
}
window.addEventListener("blur", () => game.keys.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) game.keys.clear();
});
window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", () => window.setTimeout(resizeCanvas, 100));
dom.joystick.addEventListener("pointerdown", handleJoystickDown);
dom.joystick.addEventListener("pointermove", moveJoystick);
dom.joystick.addEventListener("pointerup", (event) => {
  if (event.pointerId === game.joystick.pointerId) resetJoystick();
});
dom.joystick.addEventListener("pointercancel", resetJoystick);

dom.nameInput.value = profile.name;
dom.settingsName.value = profile.name;
updateProfileUI();
updateHud();
