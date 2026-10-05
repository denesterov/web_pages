/* ============================================================
   КОНСТАНТЫ
============================================================ */
const DIRS = [
  { dx:  0, dy: -1, ch: '↑' },
  { dx:  1, dy:  0, ch: '→' },
  { dx:  0, dy:  1, ch: '↓' },
  { dx: -1, dy:  0, ch: '←' },
];

const TOOLS = [
  { id: 'busy',  icon: '',   title: 'Занято (заштриховано)' },
  { id: 'bonus', icon: '●',  title: 'Бонус (кружок)' },
  { id: 'robot', icon: '▣',  title: 'Переставить робота (клик по роботу — поворот)' },
  { id: 'erase', icon: '⌫',  title: 'Очистить клетку' },
];

const COOKIE_NAME     = 'robot_state_v6';
const MAX_TICKS       = 1_000;  // общий предохранитель
const MAX_IDLE_PASSES = 10;         // холостых проходов цикла «повтор» подряд

let N = 12;
let cells = [];           // { busy, bonus, trace }
let robot = null;         // { x, y, dir }
let currentTool = 'busy';
let score = 0;

let initialBusy = [];
let initialBonus = [];

let ast = [];
let execCtx = null;
let isRunning = false;
let runTimer = null;
let currentLineEl = 0;
let crashed = false;

const gridEl       = document.getElementById('grid');
const programEl    = document.getElementById('program');
const indicatorEl  = document.getElementById('lineIndicator');
const crashBanner  = document.getElementById('crashBanner');
const statusEl     = document.getElementById('status');
const runBtn       = document.getElementById('runBtn');
const stepBtn      = document.getElementById('stepBtn');
const resetBtn     = document.getElementById('resetBtn');

/* ============================================================
   ВСПОМОГАТЕЛЬНЫЕ
============================================================ */
function startRobot() {
  return { x: Math.floor(N / 2), y: Math.floor(N / 2), dir: 0 };
}
function isRobotAt(x, y) { return robot && robot.x === x && robot.y === y; }

function snapshotInitial() {
  initialBusy  = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => !!cells[y][x].busy));
  initialBonus = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => !!cells[y][x].bonus));
}

function restoreInitial() {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      cells[y][x].busy  = initialBusy[y]  ? initialBusy[y][x]  : false;
      cells[y][x].bonus = initialBonus[y] ? initialBonus[y][x] : false;
      cells[y][x].trace = null;
    }
}

/* ============================================================
   COOKIES
============================================================ */
function setCookie(name, value, days = 365) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = name + '=' + encodeURIComponent(value) +
    '; expires=' + d.toUTCString() + '; path=/; SameSite=Lax';
}
function getCookie(name) {
  const parts = ('; ' + document.cookie).split('; ' + name + '=');
  if (parts.length === 2) return decodeURIComponent(parts[1].split(';')[0]);
  return '';
}
function saveState() {
  const state = {
    N,
    robot: robot ? { x: robot.x, y: robot.y, dir: robot.dir } : null,
    score,
    program: programEl.value,
    initBusy: initialBusy,
    initBonus: initialBonus,
    traces: cells.map(row => row.map(c => c.trace || null)),
  };
  try { setCookie(COOKIE_NAME, JSON.stringify(state)); } catch (e) {}
}
function loadState() {
  const raw = getCookie(COOKIE_NAME);
  if (!raw) return false;
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s.N !== 'number') return false;
    N = Math.max(2, Math.min(40, s.N | 0));
    document.getElementById('gridSize').value = N;

    cells        = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ busy: false, bonus: false, trace: null })));
    initialBusy  = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
    initialBonus = Array.from({ length: N }, () => Array.from({ length: N }, () => false));

    if (Array.isArray(s.initBusy)) {
      for (let y = 0; y < Math.min(N, s.initBusy.length); y++)
        for (let x = 0; x < Math.min(N, s.initBusy[y].length); x++) {
          initialBusy[y][x] = !!s.initBusy[y][x];
          cells[y][x].busy = initialBusy[y][x];
        }
    }
    if (Array.isArray(s.initBonus)) {
      for (let y = 0; y < Math.min(N, s.initBonus.length); y++)
        for (let x = 0; x < Math.min(N, s.initBonus[y].length); x++) {
          initialBonus[y][x] = !!s.initBonus[y][x];
          cells[y][x].bonus = initialBonus[y][x];
        }
    }
    if (Array.isArray(s.traces)) {
      for (let y = 0; y < Math.min(N, s.traces.length); y++) {
        const row = s.traces[y];
        if (!Array.isArray(row)) continue;
        for (let x = 0; x < Math.min(N, row.length); x++)
          cells[y][x].trace = row[x] || null;
      }
    }
    if (s.robot && typeof s.robot.x === 'number') {
      robot = {
        x: Math.max(0, Math.min(N - 1, s.robot.x | 0)),
        y: Math.max(0, Math.min(N - 1, s.robot.y | 0)),
        dir: ((s.robot.dir | 0) % 4 + 4) % 4,
      };
    } else {
      robot = null;
    }
    score = s.score | 0;
    if (typeof s.program === 'string') programEl.value = s.program;
    return true;
  } catch (e) { return false; }
}

/* ============================================================
   ПОЛЕ
============================================================ */
function buildTools() {
  const box = document.getElementById('tools');
  box.innerHTML = '';
  TOOLS.forEach(t => {
    const b = document.createElement('button');
    b.className = 'tool' + (t.id === currentTool ? ' active' : '');
    b.dataset.tool = t.id;
    b.title = t.title;
    b.textContent = t.icon;
    b.onclick = () => {
      currentTool = t.id;
      [...box.children].forEach(c => c.classList.remove('active'));
      b.classList.add('active');
    };
    box.appendChild(b);
  });
}

function cellSize() {
  const availW = window.innerWidth - 380 - 200 - 60;
  const availH = window.innerHeight - 140;
  return Math.max(16, Math.min(46, Math.floor(Math.min(availW, availH) / N) - 3));
}

function buildGrid() {
  const cs = cellSize();
  gridEl.style.setProperty('--cell', cs + 'px');
  gridEl.style.gridTemplateColumns = `repeat(${N}, var(--cell))`;
  gridEl.innerHTML = '';
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.dataset.x = x; c.dataset.y = y;
      c.onclick = () => onCellClick(x, y);
      gridEl.appendChild(c);
    }
  }
  renderAll();
}

function cellEl(x, y) { return gridEl.children[y * N + x]; }

function onCellClick(x, y) {
  if (isRunning) return;
  if (crashed) clearCrashVisual();

  const c = cells[y][x];
  const hasRobot = isRobotAt(x, y);

  if (currentTool === 'robot') {
    if (hasRobot) {
      robot.dir = (robot.dir + 1) % 4;
    } else {
      if (c.busy) return;
      robot = { x, y, dir: robot ? robot.dir : 0 };
    }
    renderAll();
    saveState();
    return;
  }

  if (currentTool === 'erase') {
    if (hasRobot) {
      robot.dir = (robot.dir + 1) % 4;
    } else {
      c.busy = c.bonus = false; c.trace = null;
      initialBusy[y][x] = false;
      initialBonus[y][x] = false;
    }
    renderAll();
    saveState();
    return;
  }

  if (currentTool === 'busy') {
    if (hasRobot) return;
    c.busy = !c.busy; c.bonus = false;
    initialBusy[y][x] = c.busy;
    initialBonus[y][x] = false;
    renderAll();
    saveState();
    return;
  }

  if (currentTool === 'bonus') {
    if (hasRobot) return;
    c.bonus = !c.bonus; c.busy = false;
    initialBonus[y][x] = c.bonus;
    initialBusy[y][x] = false;
    renderAll();
    saveState();
    return;
  }
}

function renderAll() {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      renderCell(x, y);
  updateRobotInfo();
}

function renderCell(x, y) {
  const el = cellEl(x, y);
  if (!el) return;
  const c = cells[y][x];
  el.className = 'cell';
  el.removeAttribute('data-trace');
  el.removeAttribute('data-dir');

  if (c.busy) el.classList.add('busy');
  if (c.bonus) el.classList.add('bonus');
  if (c.trace) { el.classList.add('trace'); el.dataset.trace = c.trace; }
  if (isRobotAt(x, y)) {
    el.classList.add('robot');
    el.dataset.dir = robot.dir;
    if (crashed) el.classList.add('crashed');
  }
}

function updateRobotInfo() {
  const el = document.getElementById('robotInfo');
  if (!robot) el.textContent = 'робот: —';
  else el.textContent = `робот: (${robot.x},${robot.y}) ${DIRS[robot.dir].ch}`;
}

function setTrace(x, y, dir) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  cells[y][x].trace = DIRS[dir].ch;
  renderCell(x, y);
}

function updateScore() {
  document.getElementById('scoreBox').textContent = score;
}

/* ============================================================
   ПАРСЕР
============================================================ */
function parseProgram(src) {
  const rawLines = src.split('\n');
  const result = [];
  const stack = [{ children: result, indent: -1 }];
  let lineNo = 0;
  for (const raw of rawLines) {
    lineNo++;
    const noComment = raw.replace(/(^|\s)#.*$/, '');
    const trimmed = noComment.replace(/\s+$/, '');
    if (!trimmed.trim()) continue;
    const indent = trimmed.match(/^ */)[0].length;
    const text = trimmed.trim();
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    const node = { line: lineNo, cmd, args, children: [] };
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (cmd === 'повтор' || cmd === 'если') {
      parent.children.push(node);
      stack.push({ children: node.children, indent });
    } else {
      parent.children.push(node);
    }
  }
  return result;
}

/* ============================================================
   ИНТЕРПРЕТАТОР — одна операция за тик
============================================================ */
function newContext() {
  return {
    tasks: [{ kind: 'block', nodes: ast, idx: 0 }],
    ticks: 0,
    progress: 0,     // сколько раз робот шагнул/повернулся
    halted: false,
    crashed: false,
  };
}

function doStep() {
  const ctx = execCtx;
  if (!ctx || ctx.halted) return { ok: false };
  if (!robot) return { ok: false, error: 'Робот не установлен на поле' };

  if (++ctx.ticks > MAX_TICKS) {
    ctx.halted = true;
    return { ok: false, error: 'Превышен лимит тиков' };
  }

  if (!ctx.tasks.length) {
    ctx.halted = true;
    return { ok: false };
  }

  const top = ctx.tasks[ctx.tasks.length - 1];

  /* ---------- BLOCK ---------- */
  if (top.kind === 'block') {
    // Тело блока закончилось — снимаем его. Один тик.
    if (top.idx >= top.nodes.length) {
      ctx.tasks.pop();

      // Если сняли тело цикла — проверяем прогресс.
      const parent = ctx.tasks[ctx.tasks.length - 1];
      if (parent && parent.kind === 'loop') {
        if (ctx.progress === parent.progressAtStart) {
          parent.idlePasses = (parent.idlePasses || 0) + 1;
          if (parent.idlePasses > MAX_IDLE_PASSES) {
            ctx.halted = true;
            return { ok: false, error: 'Бесконечный холостой цикл «повтор»' };
          }
        } else {
          parent.idlePasses = 0;
        }
      }
      return { ok: true, tick: 'close-block' };
    }

    const node = top.nodes[top.idx];
    setLineIndicator(node.line);

    /* --- шаг / вперёд --- */
    if (node.cmd === 'шаг' || node.cmd === 'вперёд' || node.cmd === 'вперед') {
      top.idx++;
      ctx.progress++;
      return doMoveForward();
    }
    /* --- повороты --- */
    if (node.cmd === 'право') {
      top.idx++;
      ctx.progress++;
      robot.dir = (robot.dir + 1) % 4;
      renderCell(robot.x, robot.y);
      return { ok: true, tick: 'право' };
    }
    if (node.cmd === 'лево') {
      top.idx++;
      ctx.progress++;
      robot.dir = (robot.dir + 3) % 4;
      renderCell(robot.x, robot.y);
      return { ok: true, tick: 'лево' };
    }
    /* --- выход: снимаем стек до ближайшего loop --- */
    if (node.cmd === 'выход') {
      top.idx++;
      let foundLoop = false;
      while (ctx.tasks.length) {
        const t = ctx.tasks.pop();
        if (t.kind === 'loop') { foundLoop = true; break; }
      }
      if (!foundLoop) {
        ctx.halted = true;
        return { ok: false, error: '«выход» вне цикла' };
      }
      return { ok: true, tick: 'выход' };
    }
    /* --- повтор: команда выполнена, пушим loop + block --- */
    if (node.cmd === 'повтор') {
      top.idx++;
      ctx.tasks.push({
        kind: 'loop',
        nodes: node.children,
        progressAtStart: ctx.progress,
        idlePasses: 0,
      });
      ctx.tasks.push({ kind: 'block', nodes: node.children, idx: 0 });
      return { ok: true, tick: 'повтор' };
    }
    /* --- если: команда выполнена, при истине пушим блок --- */
    if (node.cmd === 'если') {
      top.idx++;
      const cond = checkCondition(node.args);
      if (cond) {
        ctx.tasks.push({ kind: 'block', nodes: node.children, idx: 0 });
      }
      return { ok: true, tick: cond ? 'если(true)' : 'если(false)' };
    }
    /* --- неизвестная команда --- */
    top.idx++;
    return { ok: true, tick: 'skip' };
  }

  /* ---------- LOOP ---------- */
  if (top.kind === 'loop') {
    // Начинаем новую итерацию: пушим тело. Один тик.
    top.progressAtStart = ctx.progress;
    ctx.tasks.push({ kind: 'block', nodes: top.nodes, idx: 0 });
    return { ok: true, tick: 'loop-iter' };
  }

  // Неизвестный тип — снимаем, чтобы не зациклиться
  ctx.tasks.pop();
  return { ok: true, tick: 'pop-unknown' };
}

function doMoveForward() {
  const d = DIRS[robot.dir];
  const nx = robot.x + d.dx;
  const ny = robot.y + d.dy;
  if (nx < 0 || ny < 0 || nx >= N || ny >= N || cells[ny][nx].busy) {
    return { ok: true, crashed: true };
  }
  setTrace(robot.x, robot.y, robot.dir);
  const oldX = robot.x, oldY = robot.y;
  robot.x = nx; robot.y = ny;
  if (cells[ny][nx].bonus) {
    cells[ny][nx].bonus = false;
    score++;
    updateScore();
  }
  renderCell(oldX, oldY);
  renderCell(robot.x, robot.y);
  updateRobotInfo();
  return { ok: true, tick: 'шаг' };
}

function checkCondition(args) {
  if (!robot) return false;
  const what = args[0].toLowerCase();
  let dir = robot.dir
  if (what === 'справа') dir = (robot.dir + 1) % 4;
  else if (what === 'слева') dir = (robot.dir + 3) % 4;
  const d = DIRS[dir];
  const nx = robot.x + d.dx;
  const ny = robot.y + d.dy;
  if (nx < 0 || ny < 0 || nx >= N || ny >= N) return false;
  return !cells[ny][nx].busy;
}

/* ============================================================
   ИНДИКАТОР СТРОКИ
============================================================ */
function setLineIndicator(lineNo) {
  currentLineEl = lineNo;
  if (!lineNo) { indicatorEl.style.display = 'none'; return; }
  const style = getComputedStyle(programEl);
  const lh = parseFloat(style.lineHeight) || 20;
  const padTop = parseFloat(style.paddingTop) || 0;
  const scrollTop = programEl.scrollTop;
  const y = padTop + (lineNo - 1) * lh - scrollTop;
  indicatorEl.style.display = 'block';
  indicatorEl.style.top = (programEl.offsetTop + y) + 'px';
  indicatorEl.style.height = lh + 'px';
  indicatorEl.style.left = (programEl.offsetLeft + 4) + 'px';
  indicatorEl.style.width = (programEl.offsetWidth - 12) + 'px';
}
programEl.addEventListener('scroll', () => {
  if (currentLineEl) setLineIndicator(currentLineEl);
});

/* ============================================================
   ЗАПУСК
============================================================ */
function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}
function compileIfNeeded() {
  if (execCtx && !execCtx.halted && !crashed) return true;
  const src = programEl.value;
  try {
    ast = parseProgram(src);
    if (!ast.length) throw new Error('Программа пуста');
  } catch (e) {
    setStatus('Ошибка: ' + e.message, 'err');
    return false;
  }
  return true;
}

function startProgram() {
  if (crashed) clearCrashVisual();
  if (!robot) robot = startRobot();
  if (!compileIfNeeded()) return;
  if (!execCtx || execCtx.halted) {
    resetExecutionState(false);
    execCtx = newContext();
  }
  isRunning = true;
  runBtn.disabled = true;
  setStatus('▶ Выполняется...');
  tick();
}

function tick() {
  if (!isRunning || !execCtx) return;
  const r = doStep();

  if (r.crashed) { triggerCrash(); return; }
  if (r.error)   { finishProgram(r.error); return; }
  if (!r.ok)     { finishProgram(); return; }

  const info = r.tick ? ` [${r.tick}]` : '';
  setStatus(`▶ тик ${execCtx.ticks}, строка ${currentLineEl}${info}`);
  runTimer = setTimeout(tick, 500);   // 2 тика в секунду
}

function finishProgram(errorMsg) {
  isRunning = false;
  clearTimeout(runTimer);
  runBtn.disabled = false;
  if (errorMsg) setStatus('⏹ ' + errorMsg, 'err');
  else setStatus(`✔ Завершено. Тиков: ${execCtx ? execCtx.ticks : 0}, бонусов: ${score}`, 'ok');
  indicatorEl.style.display = 'none';
  currentLineEl = 0;
  saveState();
}

/* ============================================================
   АВАРИЯ
============================================================ */
function triggerCrash() {
  isRunning = false;
  clearTimeout(runTimer);
  runBtn.disabled = false;
  crashed = true;
  if (robot) {
    const el = cellEl(robot.x, robot.y);
    if (el) el.classList.add('crashed');
  }
  crashBanner.classList.add('show');
  setTimeout(() => crashBanner.classList.remove('show'), 2200);
  setStatus(`⚠ АВАРИЯ: робот наткнулся на препятствие (строка ${currentLineEl})`, 'crash');
  if (execCtx) { execCtx.halted = true; execCtx.crashed = true; }
  indicatorEl.style.display = 'none';
  saveState();
}
function clearCrashVisual() {
  crashed = false;
  [...gridEl.children].forEach(c => c.classList.remove('crashed'));
  if (execCtx) execCtx.crashed = false;
}

function doOneStep() {
  if (isRunning) return;
  if (crashed) clearCrashVisual();
  if (!robot) robot = startRobot();
  if (!compileIfNeeded()) return;
  if (!execCtx || execCtx.halted) {
    resetExecutionState(false);
    execCtx = newContext();
  }
  const r = doStep();

  if (r.crashed) { triggerCrash(); return; }
  if (r.error)   { finishProgram(r.error); return; }
  if (!r.ok)     { finishProgram(); return; }

  const info = r.tick ? ` [${r.tick}]` : '';
  setStatus(`⏭ тик ${execCtx.ticks}, строка ${currentLineEl}${info}`, 'ok');
}

function resetExecutionState(clearTraces) {
  isRunning = false;
  clearTimeout(runTimer);
  execCtx = null;
  runBtn.disabled = false;
  indicatorEl.style.display = 'none';
  currentLineEl = 0;
  clearCrashVisual();
  if (clearTraces !== false) {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        cells[y][x].trace = null;
        renderCell(x, y);
      }
  }
}

/* ============================================================
   КНОПКИ УПРАВЛЕНИЯ
============================================================ */
runBtn.onclick  = startProgram;
stepBtn.onclick = doOneStep;

resetBtn.onclick = () => {
  resetExecutionState(true);
  restoreInitial();
  robot = startRobot();
  score = 0;
  updateScore();
  renderAll();
  setStatus('⟲ Сброс: робот в центре, следы стёрты, бонусы восстановлены, счёт = 0.', 'ok');
  saveState();
};

/* ============================================================
   КОПИРОВАНИЕ / ВСТАВКА
============================================================ */
document.getElementById('copyBtn').onclick = async () => {
  const lines = [];
  for (let y = 0; y < N; y++) {
    let line = '';
    for (let x = 0; x < N; x++) {
      if (isRobotAt(x, y)) {
        line += DIRS[robot.dir].ch;   // стрелка направления робота
      } else if (cells[y][x].busy) {
        line += 'X';
      } else if (cells[y][x].bonus) {
        line += 'O';
      } else {
        line += '.';
      }
    }
    lines.push(line);
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`📋 Скопировано (${N}×${N})`, 'ok');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    setStatus('📋 Скопировано (fallback)', 'ok');
  }
};

document.getElementById('pasteBtn').onclick = async () => {
  if (isRunning) return;
  let text = '';
  try { text = await navigator.clipboard.readText(); }
  catch (e) { setStatus('Нет доступа к буферу', 'err'); return; }
  if (!text) { setStatus('Буфер пуст', 'err'); return; }

  const norm = text.replace(/\r\n?/g, '\n');
  const allLines = norm.split('\n');
  while (allLines.length && allLines[allLines.length - 1] === '') allLines.pop();
  if (!allLines.length) { setStatus('Нет данных', 'err'); return; }

  const rows = allLines.length;
  const cols = allLines[0].length;
  let ok = true, errMsg = '';

  if (cols < 2 || cols > 40) { ok = false; errMsg = `длина строки = ${cols}, ожидается 2..40`; }
  if (ok && rows !== cols)   { ok = false; errMsg = `${rows}×${cols} — не квадрат N×N`; }
  if (ok) {
    const allowed = new Set(['.', 'X', 'O', 'R', '↑', '→', '↓', '←', 'x', 'o', 'r', '#']);
    for (let i = 0; i < rows; i++) {
      if (allLines[i].length !== cols) {
        ok = false; errMsg = `строка ${i + 1}: длина ${allLines[i].length}`; break;
      }
      for (let j = 0; j < cols; j++) {
        if (!allowed.has(allLines[i][j])) {
          ok = false; errMsg = `строка ${i + 1}, символ ${j + 1}: "${allLines[i][j]}"`; break;
        }
      }
      if (!ok) break;
    }
  }
  if (!ok) { setStatus('⚠ Формат неверный: ' + errMsg + '. Поле не изменено.', 'err'); return; }

  N = cols;
  document.getElementById('gridSize').value = N;
  resetExecutionState(true);
  score = 0; updateScore();

  cells        = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ busy: false, bonus: false, trace: null })));
  initialBusy  = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
  initialBonus = Array.from({ length: N }, () => Array.from({ length: N }, () => false));

  let placed = null;
  for (let y = 0; y < rows; y++) {
    const line = allLines[y];
    for (let x = 0; x < cols; x++) {
      const ch = line[x];
      if (ch === 'X' || ch === 'x' || ch === '#') {
        cells[y][x].busy = true;
        initialBusy[y][x] = true;
      } else if (ch === 'O' || ch === 'o') {
        cells[y][x].bonus = true;
        initialBonus[y][x] = true;
      } else if (ch === 'R' || ch === 'r') {
        placed = { x, y, dir: 0 };
      } else if (ch === '↑') { placed = { x, y, dir: 0 }; }
      else if (ch === '→')   { placed = { x, y, dir: 1 }; }
      else if (ch === '↓')   { placed = { x, y, dir: 2 }; }
      else if (ch === '←')   { placed = { x, y, dir: 3 }; }
    }
  }
  robot = placed || startRobot();

  buildGrid();
  setStatus(`📥 Вставлено поле ${N}×${N}`, 'ok');
  saveState();
};

/* ============================================================
   ПРОЧЕЕ
============================================================ */
document.getElementById('applySize').onclick = () => {
  const v = parseInt(document.getElementById('gridSize').value, 10);
  if (v >= 2 && v <= 40) {
    N = v;
    resetExecutionState(true);
    score = 0; updateScore();
    cells        = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ busy: false, bonus: false, trace: null })));
    initialBusy  = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
    initialBonus = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
    robot = startRobot();
    buildGrid();
    setStatus('Размер изменён. Робот в центре.', 'ok');
    saveState();
  }
};

document.getElementById('clearGrid').onclick = () => {
  if (isRunning) return;
  cells        = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ busy: false, bonus: false, trace: null })));
  initialBusy  = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
  initialBonus = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
  robot = startRobot();
  score = 0;
  updateScore();
  renderAll();
  setStatus('Поле очищено. Робот в центре.');
  saveState();
};

let programSaveTimer = null;
programEl.addEventListener('input', () => {
  clearTimeout(programSaveTimer);
  programSaveTimer = setTimeout(saveState, 400);
});
window.addEventListener('resize', () => {
  const cs = cellSize();
  gridEl.style.setProperty('--cell', cs + 'px');
});
window.addEventListener('beforeunload', saveState);

/* ============================================================
   СТАРТ
============================================================ */
buildTools();

const loaded = loadState();

if (!loaded) {
  cells        = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ busy: false, bonus: false, trace: null })));
  initialBusy  = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
  initialBonus = Array.from({ length: N }, () => Array.from({ length: N }, () => false));
  robot = startRobot();
}
if (!robot) robot = startRobot();

snapshotInitial();   // зафиксировать исходное состояние для кнопки Сброс
buildGrid();
updateScore();

if (loaded) setStatus('↻ Состояние восстановлено из cookies.', 'ok');
else setStatus('Готов. Робот в центре. Скорость: 2 тика/сек.');