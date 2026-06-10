const $ = (id) => document.getElementById(id);

const screens = ["menu-screen", "lobby-screen", "room-screen", "auth-screen", "daily-screen", "game-screen"];
function showScreen(id) {
  screens.forEach((s) => $(s).classList.toggle("hidden", s !== id));
  document.body.dataset.screen = id;
  const navKey = id === "daily-screen" ? "daily" : "menu";
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("active", el.dataset.nav === navKey);
  });
}

const DIFF_NAMES = { easy: "简单", medium: "中等", hard: "困难", expert: "专家" };

let difficulty = "easy";
let mode = null; // "single" | "multi"
let gameId = null;
let puzzle = null;
let board = null;
let selected = null;
let timerInterval = null;
let seconds = 0;

// multiplayer state
let ws = null;
let playerId = null;
let roomCode = null;
let gameOver = false;

// ---- auth ----

const getToken = () => localStorage.getItem("sudoku_token");
const setToken = (t) => t ? localStorage.setItem("sudoku_token", t) : localStorage.removeItem("sudoku_token");

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

let currentUser = null; // {username, total_completed}

async function refreshProfile() {
  currentUser = null;
  if (getToken()) {
    const res = await fetch("/api/me", { headers: authHeaders() });
    const data = await res.json();
    if (!data.error) currentUser = data;
    else setToken(null);
  }
  if (currentUser) {
    $("profile-name").textContent = currentUser.username;
    $("profile-level").textContent = `已完成 ${currentUser.total_completed} 题`;
    $("auth-username-display").textContent = currentUser.username;
    $("auth-total-display").textContent = `累计完成 ${currentUser.total_completed} 个数独`;
  } else {
    $("profile-name").textContent = "未登录";
    $("profile-level").textContent = "点头像登录账号";
  }
  $("auth-logged-in").classList.toggle("hidden", !currentUser);
  $("auth-forms").classList.toggle("hidden", !!currentUser);
}

async function doAuth(path) {
  const username = $("auth-username").value.trim();
  const password = $("auth-password").value;
  if (!username || !password) {
    $("auth-error").textContent = "请输入用户名和密码";
    return;
  }
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (data.error) {
    $("auth-error").textContent = data.error;
    return;
  }
  setToken(data.token);
  $("auth-error").textContent = "";
  $("auth-password").value = "";
  await refreshProfile();
  showScreen("menu-screen");
}

$("btn-login").addEventListener("click", () => doAuth("/api/login"));
$("btn-register").addEventListener("click", () => doAuth("/api/register"));
$("auth-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doAuth("/api/login");
});

$("btn-logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", headers: authHeaders() });
  setToken(null);
  await refreshProfile();
  showScreen("menu-screen");
});

document.querySelectorAll(".auth-entry").forEach((el) => {
  el.addEventListener("click", () => {
    $("auth-error").textContent = "";
    showScreen("auth-screen");
  });
});

$("btn-auth-back").addEventListener("click", () => showScreen("menu-screen"));

// ---- navigation ----

document.querySelectorAll("[data-nav]").forEach((el) => {
  el.addEventListener("click", () => {
    if (el.dataset.nav === "daily") openDaily();
    else showScreen("menu-screen");
  });
});

// ---- daily achievements calendar ----

const now = new Date();
let calYear = now.getFullYear();
let calMonth = now.getMonth() + 1; // 1-12

function openDaily() {
  showScreen("daily-screen");
  renderCalendar();
}

$("cal-prev").addEventListener("click", () => {
  calMonth--;
  if (calMonth < 1) { calMonth = 12; calYear--; }
  renderCalendar();
});

$("cal-next").addEventListener("click", () => {
  calMonth++;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  renderCalendar();
});

$("btn-daily-back").addEventListener("click", () => showScreen("menu-screen"));

async function renderCalendar() {
  $("cal-title").textContent = `${calYear} 年 ${calMonth} 月`;
  const grid = $("calendar");
  grid.innerHTML = "";
  $("daily-hint").textContent = "";

  let days = {};
  if (!getToken()) {
    $("daily-hint").textContent = "登录后可记录并查看每日战绩";
  } else {
    const res = await fetch(`/api/stats/daily?year=${calYear}&month=${calMonth}`, { headers: authHeaders() });
    const data = await res.json();
    if (data.error) $("daily-hint").textContent = "登录后可记录并查看每日战绩";
    else days = data.days;
  }

  const firstDay = new Date(calYear, calMonth - 1, 1).getDay(); // 0 = Sunday
  const numDays = new Date(calYear, calMonth, 0).getDate();
  const today = new Date();
  const isThisMonth = today.getFullYear() === calYear && today.getMonth() + 1 === calMonth;

  for (let i = 0; i < firstDay; i++) {
    grid.appendChild(document.createElement("div"));
  }
  for (let d = 1; d <= numDays; d++) {
    const cell = document.createElement("div");
    cell.className = "cal-day";
    if (isThisMonth && d === today.getDate()) cell.classList.add("today");
    const key = `${calYear}-${String(calMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const stat = days[key];
    let inner = `<span class="cal-date">${d}</span>`;
    if (stat) {
      cell.classList.add("has-record");
      inner += `<span class="cal-count">${stat.count} 题</span>`;
      inner += `<span class="cal-best">⏱ ${formatTime(stat.best)}</span>`;
    }
    cell.innerHTML = inner;
    grid.appendChild(cell);
  }
}

// ---- menu ----

document.querySelectorAll(".diff-card").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".diff-card").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    difficulty = btn.dataset.diff;
  });
});

async function startSingleGame() {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  stopTimer();
  mode = "single";
  const res = await fetch("/api/new-game", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ difficulty }),
  });
  const data = await res.json();
  gameId = data.game_id;
  startGame(data.puzzle);
}

$("btn-single").addEventListener("click", startSingleGame);
$("btn-play-now").addEventListener("click", startSingleGame);

$("btn-multi").addEventListener("click", () => {
  $("lobby-error").textContent = "";
  if (currentUser && !$("player-name").value) $("player-name").value = currentUser.username;
  showScreen("lobby-screen");
});

// ---- lobby ----

function connectWS(onOpen) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = onOpen;
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (mode === "multi" && !gameOver) {
      $("lobby-error").textContent = "连接已断开";
      showScreen("lobby-screen");
      stopTimer();
    }
  };
}

function playerName() {
  return $("player-name").value.trim() || (currentUser ? currentUser.username : "玩家");
}

$("btn-create-room").addEventListener("click", () => {
  mode = "multi";
  connectWS(() => ws.send(JSON.stringify({
    action: "create_room", difficulty, name: playerName(), token: getToken(),
  })));
});

$("btn-join-room").addEventListener("click", () => {
  const code = $("room-code-input").value.trim().toUpperCase();
  if (code.length !== 4) {
    $("lobby-error").textContent = "请输入 4 位房间码";
    return;
  }
  mode = "multi";
  connectWS(() => ws.send(JSON.stringify({
    action: "join_room", code, name: playerName(), token: getToken(),
  })));
});

$("btn-lobby-back").addEventListener("click", () => showScreen("menu-screen"));

$("btn-room-back").addEventListener("click", () => {
  if (ws) ws.close();
  ws = null;
  showScreen("lobby-screen");
});

$("btn-start-game").addEventListener("click", () => {
  $("room-error").textContent = "";
  ws.send(JSON.stringify({ action: "start_game" }));
});

function handleMessage(msg) {
  switch (msg.type) {
    case "joined":
      playerId = msg.player_id;
      roomCode = msg.code;
      $("room-code-display").textContent = roomCode;
      showScreen("room-screen");
      break;
    case "room_state":
      renderRoomState(msg);
      break;
    case "game_start":
      gameOver = false;
      startGame(msg.puzzle);
      break;
    case "check_result":
      applyCheckResult(msg);
      break;
    case "game_over":
      gameOver = true;
      stopTimer();
      refreshProfile();
      showResult(
        msg.winner === playerName() ? "🎉 你赢了！" : "游戏结束",
        `获胜者：${msg.winner}`
      );
      break;
    case "error": {
      const el = $("room-screen").classList.contains("hidden") ? "lobby-error" : "room-error";
      $(el).textContent = msg.message;
      break;
    }
  }
}

function renderRoomState(state) {
  difficulty = state.difficulty;
  $("room-difficulty").textContent = DIFF_NAMES[state.difficulty] || state.difficulty;
  const ul = $("room-players");
  ul.innerHTML = "";
  state.players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.name + (p.id === playerId ? "（我）" : "");
    ul.appendChild(li);
  });
  if (state.started) renderOpponents(state.players);
}

function renderOpponents(players) {
  const div = $("opponents");
  div.classList.remove("hidden");
  div.innerHTML = "";
  players.filter((p) => p.id !== playerId).forEach((p) => {
    const row = document.createElement("div");
    row.className = "opponent-row";
    const pct = Math.round(p.progress * 100);
    row.innerHTML = `<span class="name"></span>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span>${pct}%</span>`;
    row.querySelector(".name").textContent = p.name;
    div.appendChild(row);
  });
}

// ---- game ----

function startGame(p) {
  puzzle = p;
  board = p.map((row) => row.slice());
  selected = null;
  $("game-mode-label").textContent =
    (mode === "single" ? "单人" : `对战 ${roomCode}`) + " · " + (DIFF_NAMES[difficulty] || "");
  $("check-message").textContent = "";
  $("opponents").classList.toggle("hidden", mode !== "multi");
  if (mode === "multi") $("opponents").innerHTML = "";
  renderBoard();
  showScreen("game-screen");
  startTimer();
}

function renderBoard() {
  const el = $("board");
  el.innerHTML = "";
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      if (c === 2 || c === 5) cell.classList.add("box-right");
      if (r === 2 || r === 5) cell.classList.add("box-bottom");
      if (puzzle[r][c] !== 0) cell.classList.add("given");
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.textContent = board[r][c] || "";
      cell.addEventListener("click", () => selectCell(r, c));
      el.appendChild(cell);
    }
  }
  updateHighlights();
}

function cellEl(r, c) {
  return $("board").children[r * 9 + c];
}

function selectCell(r, c) {
  selected = [r, c];
  updateHighlights();
}

function updateHighlights() {
  const selVal = selected ? board[selected[0]][selected[1]] : 0;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const el = cellEl(r, c);
      el.classList.remove("selected", "same-num");
      if (selected && selected[0] === r && selected[1] === c) el.classList.add("selected");
      else if (selVal && board[r][c] === selVal) el.classList.add("same-num");
    }
  }
}

function setNumber(num) {
  if (!selected) return;
  const [r, c] = selected;
  if (puzzle[r][c] !== 0) return;
  board[r][c] = num;
  const el = cellEl(r, c);
  el.textContent = num || "";
  el.classList.remove("wrong", "conflict");
  $("check-message").textContent = "";
  updateHighlights();
  if (mode === "multi" && ws && !gameOver) {
    ws.send(JSON.stringify({ action: "update_board", board }));
  }
}

document.querySelectorAll(".num-btn").forEach((btn) => {
  btn.addEventListener("click", () => setNumber(parseInt(btn.dataset.num, 10)));
});

document.addEventListener("keydown", (e) => {
  if ($("game-screen").classList.contains("hidden")) return;
  if (e.key >= "1" && e.key <= "9") setNumber(parseInt(e.key, 10));
  else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") setNumber(0);
  else if (selected && e.key.startsWith("Arrow")) {
    e.preventDefault();
    let [r, c] = selected;
    if (e.key === "ArrowUp") r = Math.max(0, r - 1);
    if (e.key === "ArrowDown") r = Math.min(8, r + 1);
    if (e.key === "ArrowLeft") c = Math.max(0, c - 1);
    if (e.key === "ArrowRight") c = Math.min(8, c + 1);
    selectCell(r, c);
  }
});

// ---- check ----

$("btn-check").addEventListener("click", async () => {
  if (mode === "single") {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gameId, board }),
    });
    applyCheckResult(await res.json());
  } else if (ws && !gameOver) {
    ws.send(JSON.stringify({ action: "check", board }));
  }
});

function applyCheckResult(result) {
  document.querySelectorAll(".cell").forEach((el) => el.classList.remove("wrong", "conflict"));
  result.wrong.forEach(([r, c]) => cellEl(r, c).classList.add("wrong"));
  result.conflicts.forEach(([r, c]) => cellEl(r, c).classList.add("conflict"));

  const msg = $("check-message");
  if (result.complete) {
    msg.textContent = "✓ 全部正确，恭喜完成！";
    msg.className = "check-message ok";
    if (mode === "single") {
      stopTimer();
      refreshProfile();
      const t = result.seconds != null ? result.seconds : seconds;
      showResult("🎉 完成！", `用时 ${formatTime(t)}`);
    }
  } else if (result.wrong.length === 0 && result.conflicts.length === 0) {
    msg.textContent = "目前填写的数字全部正确，继续加油！";
    msg.className = "check-message ok";
  } else {
    msg.textContent = `发现 ${result.wrong.length} 个错误数字`;
    msg.className = "check-message bad";
  }
}

// ---- misc ----

function startTimer() {
  stopTimer();
  seconds = 0;
  $("timer").textContent = "00:00";
  timerInterval = setInterval(() => {
    seconds++;
    $("timer").textContent = formatTime(seconds);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function formatTime(s) {
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function showResult(title, detail) {
  $("result-title").textContent = title;
  $("result-detail").textContent = detail;
  $("result-overlay").classList.remove("hidden");
}

$("btn-result-ok").addEventListener("click", () => {
  $("result-overlay").classList.add("hidden");
  quitToMenu();
});

$("btn-quit").addEventListener("click", quitToMenu);

function quitToMenu() {
  stopTimer();
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  gameOver = false;
  showScreen("menu-screen");
}

refreshProfile();
