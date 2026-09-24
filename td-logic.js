// td-logic.js — スライム防衛隊タワーディフェンスのゲームロジック（DOM非依存）
//
// 設計方針:
//  - このファイルは Canvas / Image / AudioContext / document に一切触れない。
//    Node からそのまま import してテストできる（test-slime-tower.mjs 参照）。
//  - 乱数は Math.random() を直接呼ばず、シード可能な mulberry32 のみを使う。
//  - stepGame(game, dt) が唯一の時間進行関数。呼ぶ側（HTML / テスト）が
//    dt を決める＝決定的に再生できる。
//  - 見た目・音は game.events に積まれるイベント（'hit'/'kill'/'life-lost'/
//    'wave-start'/'stage-clear'/'all-clear'/'lost'/'shot'）を描画側が
//    drainEvents() で取り出して処理する。ロジック側はそれ以上関与しない。

// ---------------------------------------------------------------------------
// 乱数（シード可能）
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// タワー・敵の基礎パラメータ
// ---------------------------------------------------------------------------
export const TOWER_TYPES = {
  cannon: {
    label: '砲台',
    cost: 45,
    range: 2.6,
    damage: 8,
    fireRate: 2.2,        // 発/秒
    projectileSpeed: 9,   // セル/秒
    splashRadius: 0,
    splashDamageMul: 0,
    upgradeCostMul: 0.75,
    damagePerLevel: 0.5,  // 1レベル毎に +50%
    maxLevel: 4,
    sellRefund: 0.65,
    baseSprite: 249,
    barrelSprites: [226, 227, 228, 229],
  },
  missile: {
    label: 'ミサイル砲',
    cost: 85,
    range: 3.4,
    damage: 24,
    fireRate: 0.8,
    projectileSpeed: 5.5,
    splashRadius: 0.8,
    splashDamageMul: 0.5,
    upgradeCostMul: 0.75,
    damagePerLevel: 0.5,
    maxLevel: 4,
    sellRefund: 0.65,
    baseSprite: 250,
    barrelSprites: [203, 204, 205, 206],
  },
};

export const ENEMY_KINDS = {
  runner: { hp: 26, speed: 1.7, reward: 9, leak: 1 },
  tank: { hp: 85, speed: 0.85, reward: 20, leak: 2 },
  flyer: { hp: 16, speed: 2.4, reward: 11, leak: 1 },
};

const INTERMISSION_TIME = 2.4; // 秒
const GROUP_REST = 0.6;

// ---------------------------------------------------------------------------
// 経路・建設スロットの生成
// ---------------------------------------------------------------------------
export function expandWaypoints(waypoints) {
  const cells = [waypoints[0].slice()];
  for (let i = 1; i < waypoints.length; i++) {
    const [x0, y0] = waypoints[i - 1];
    const [x1, y1] = waypoints[i];
    if (x0 === x1 && y0 === y1) continue;
    if (x0 === x1) {
      const step = y1 > y0 ? 1 : -1;
      for (let y = y0 + step; ; y += step) {
        cells.push([x0, y]);
        if (y === y1) break;
      }
    } else if (y0 === y1) {
      const step = x1 > x0 ? 1 : -1;
      for (let x = x0 + step; ; x += step) {
        cells.push([x, y0]);
        if (x === x1) break;
      }
    } else {
      throw new Error('waypoints must be axis-aligned: ' + JSON.stringify([waypoints[i - 1], waypoints[i]]));
    }
  }
  return cells;
}

export function computeSlots(path, cols, rows) {
  const pathSet = new Set(path.map(([x, y]) => x + ',' + y));
  const slotSet = new Set();
  const slots = [];
  for (const [x, y] of path) {
    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const key = nx + ',' + ny;
      if (pathSet.has(key) || slotSet.has(key)) continue;
      slotSet.add(key);
      slots.push({ x: nx, y: ny, towerId: null });
    }
  }
  return slots;
}

function buildWaveSpawnList(parts) {
  const list = [];
  let t = 0;
  for (const part of parts) {
    for (let i = 0; i < part.count; i++) {
      list.push({ t: t + i * part.gap, kind: part.kind });
    }
    t += part.count * part.gap + GROUP_REST;
  }
  return list;
}

// ---------------------------------------------------------------------------
// ステージ定義
// ---------------------------------------------------------------------------
const COLS = 7;
const ROWS = 12;

function stage(def) {
  const path = expandWaypoints(def.waypoints);
  const slots = computeSlots(path, COLS, ROWS);
  return {
    id: def.id,
    name: def.name,
    theme: def.theme,           // 'grass' | 'sand' | 'rock'
    cols: COLS,
    rows: ROWS,
    path,
    pathLen: path.length - 1,
    slots,
    enemySprites: def.enemySprites,
    difficultyMul: def.difficultyMul,
    waveClearBonus: def.waveClearBonus,
    waves: def.waves.map(buildWaveSpawnList),
  };
}

export const STAGES = [
  stage({
    id: 0,
    name: '第1面 牧草地の見張り',
    theme: 'grass',
    enemySprites: { runner: 268, tank: 291, flyer: 270 },
    difficultyMul: { hp: 1.0, speed: 1.0 },
    waveClearBonus: (w) => 20 + w * 6,
    waypoints: [[0, 1], [3, 1], [3, 4], [1, 4], [1, 7], [5, 7], [5, 9], [6, 9], [6, 11]],
    waves: [
      [{ kind: 'runner', count: 6, gap: 1.0 }],
      [{ kind: 'runner', count: 8, gap: 0.9 }],
      [{ kind: 'runner', count: 5, gap: 0.9 }, { kind: 'tank', count: 2, gap: 2.2 }],
      [{ kind: 'runner', count: 8, gap: 0.8 }, { kind: 'tank', count: 3, gap: 2.0 }],
    ],
  }),
  stage({
    id: 1,
    name: '第2面 砂丘の隘路',
    theme: 'sand',
    enemySprites: { runner: 269, tank: 292, flyer: 271 },
    difficultyMul: { hp: 1.15, speed: 1.05 },
    waveClearBonus: (w) => 24 + w * 6,
    waypoints: [[6, 0], [6, 2], [2, 2], [2, 4], [5, 4], [5, 6], [1, 6], [1, 8], [4, 8], [4, 11]],
    waves: [
      [{ kind: 'runner', count: 8, gap: 0.85 }],
      [{ kind: 'runner', count: 6, gap: 0.8 }, { kind: 'tank', count: 2, gap: 2.0 }],
      [{ kind: 'runner', count: 8, gap: 0.75 }, { kind: 'flyer', count: 3, gap: 1.4 }],
      [{ kind: 'tank', count: 4, gap: 1.8 }, { kind: 'runner', count: 6, gap: 0.7 }],
      [{ kind: 'runner', count: 10, gap: 0.7 }, { kind: 'tank', count: 4, gap: 1.7 }, { kind: 'flyer', count: 4, gap: 1.2 }],
    ],
  }),
  stage({
    id: 2,
    name: '第3面 岩盤地帯の攻防',
    theme: 'rock',
    enemySprites: { runner: 268, tank: 292, flyer: 271 },
    difficultyMul: { hp: 1.3, speed: 1.08 },
    waveClearBonus: (w) => 28 + w * 7,
    waypoints: [[0, 0], [0, 3], [3, 3], [3, 1], [6, 1], [6, 4], [4, 4], [4, 7], [6, 7], [6, 9], [2, 9], [2, 11]],
    waves: [
      [{ kind: 'runner', count: 8, gap: 0.8 }, { kind: 'flyer', count: 2, gap: 1.4 }],
      [{ kind: 'tank', count: 4, gap: 1.6 }],
      [{ kind: 'runner', count: 10, gap: 0.65 }, { kind: 'tank', count: 3, gap: 1.8 }],
      [{ kind: 'flyer', count: 6, gap: 1.0 }, { kind: 'runner', count: 6, gap: 0.7 }],
      [{ kind: 'runner', count: 10, gap: 0.6 }, { kind: 'tank', count: 5, gap: 1.5 }, { kind: 'flyer', count: 5, gap: 1.0 }],
    ],
  }),
  stage({
    id: 3,
    name: '第4面 最終防衛ライン',
    theme: 'grass',
    enemySprites: { runner: 269, tank: 291, flyer: 270 },
    difficultyMul: { hp: 1.5, speed: 1.12 },
    waveClearBonus: (w) => 32 + w * 7,
    waypoints: [[6, 0], [6, 1], [1, 1], [1, 3], [6, 3], [6, 5], [0, 5], [0, 7], [6, 7], [6, 9], [3, 9], [3, 11]],
    waves: [
      [{ kind: 'runner', count: 10, gap: 0.7 }],
      [{ kind: 'tank', count: 5, gap: 1.4 }],
      [{ kind: 'flyer', count: 8, gap: 0.9 }],
      [{ kind: 'runner', count: 12, gap: 0.55 }, { kind: 'tank', count: 4, gap: 1.5 }],
      [{ kind: 'tank', count: 6, gap: 1.3 }, { kind: 'flyer', count: 6, gap: 0.9 }],
      [{ kind: 'runner', count: 14, gap: 0.5 }, { kind: 'tank', count: 6, gap: 1.3 }, { kind: 'flyer', count: 8, gap: 0.8 }],
    ],
  }),
];

export const START_GOLD = 130;
export const START_LIFE = 26;

// STAGES[n] は全ゲームインスタンスで共有される定義（path/waves は読み取り専用）。
// slots だけは towerId を書き換える可変状態なので、ゲームごとに複製して使う。
// これを怠ると、複数の createGame() を同一プロセス内で使い回したときに
// 前のプレイの建設状況が次のプレイに残ってしまう（テストで実際に踏んだ）。
function instantiateStage(stageDef) {
  return {
    ...stageDef,
    slots: stageDef.slots.map((s) => ({ x: s.x, y: s.y, towerId: null })),
  };
}

// ---------------------------------------------------------------------------
// ゲーム状態
// ---------------------------------------------------------------------------
export function createGame(seed) {
  const game = {
    seed,
    rng: mulberry32(seed >>> 0),
    stageIndex: 0,
    stage: instantiateStage(STAGES[0]),
    gold: START_GOLD,
    life: START_LIFE,
    waveIndex: 0,
    waveState: 'intermission', // 'intermission' | 'active'
    waveTimer: 0,
    spawnQueue: [],
    enemies: [],
    towers: [],
    projectiles: [],
    status: 'playing', // 'playing' | 'stage-clear' | 'all-clear' | 'lost'
    elapsed: 0,
    events: [],
    _nextId: 1,
  };
  return game;
}

export function drainEvents(game) {
  const ev = game.events;
  game.events = [];
  return ev;
}

function emit(game, event) {
  game.events.push(event);
}

function enemyPos(stage, enemy) {
  const path = stage.path;
  const maxIdx = path.length - 1;
  let idx = Math.floor(enemy.distance);
  if (idx >= maxIdx) idx = maxIdx - 1;
  if (idx < 0) idx = 0;
  const t = Math.min(1, Math.max(0, enemy.distance - idx));
  const a = path[idx];
  const b = path[Math.min(idx + 1, maxIdx)];
  return {
    x: a[0] + (b[0] - a[0]) * t + 0.5,
    y: a[1] + (b[1] - a[1]) * t + 0.5,
    angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
  };
}

function spawnEnemy(game, kind) {
  const base = ENEMY_KINDS[kind];
  const dm = game.stage.difficultyMul;
  const waveRamp = 1 + 0.05 * game.waveIndex;
  const jitter = 0.97 + game.rng() * 0.06; // ±3%
  const hp = base.hp * dm.hp * waveRamp * jitter;
  const speed = base.speed * dm.speed * (1 + 0.02 * game.waveIndex) * jitter;
  const enemy = {
    id: game._nextId++,
    kind,
    distance: 0,
    hp,
    maxHp: hp,
    speed,
    reward: base.reward,
    leak: base.leak,
    dead: false,
  };
  game.enemies.push(enemy);
}

export function buildTower(game, slotIndex, type) {
  if (game.status !== 'playing') return { ok: false, reason: 'not-playing' };
  const slot = game.stage.slots[slotIndex];
  if (!slot) return { ok: false, reason: 'bad-slot' };
  if (slot.towerId != null) return { ok: false, reason: 'occupied' };
  const def = TOWER_TYPES[type];
  if (!def) return { ok: false, reason: 'bad-type' };
  if (game.gold < def.cost) return { ok: false, reason: 'no-gold' };
  game.gold -= def.cost;
  const tower = {
    id: game._nextId++,
    slotIndex,
    type,
    level: 1,
    damage: def.damage,
    range: def.range,
    fireRate: def.fireRate,
    cooldown: 0,
    spentTotal: def.cost,
  };
  game.towers.push(tower);
  slot.towerId = tower.id;
  return { ok: true, tower };
}

function findTowerBySlot(game, slotIndex) {
  return game.towers.find((t) => t.slotIndex === slotIndex) || null;
}

export function upgradeTower(game, slotIndex) {
  if (game.status !== 'playing') return { ok: false, reason: 'not-playing' };
  const tower = findTowerBySlot(game, slotIndex);
  if (!tower) return { ok: false, reason: 'no-tower' };
  const def = TOWER_TYPES[tower.type];
  if (tower.level >= def.maxLevel) return { ok: false, reason: 'max-level' };
  const cost = Math.round(def.cost * def.upgradeCostMul * tower.level);
  if (game.gold < cost) return { ok: false, reason: 'no-gold' };
  game.gold -= cost;
  tower.level += 1;
  tower.damage = def.damage * (1 + def.damagePerLevel * (tower.level - 1));
  tower.spentTotal += cost;
  return { ok: true, tower, cost };
}

export function sellTower(game, slotIndex) {
  if (game.status !== 'playing') return { ok: false, reason: 'not-playing' };
  const tower = findTowerBySlot(game, slotIndex);
  if (!tower) return { ok: false, reason: 'no-tower' };
  const def = TOWER_TYPES[tower.type];
  const refund = Math.round(tower.spentTotal * def.sellRefund);
  game.gold += refund;
  game.towers = game.towers.filter((t) => t.id !== tower.id);
  game.stage.slots[slotIndex].towerId = null;
  return { ok: true, refund };
}

export function advanceStage(game) {
  if (game.status !== 'stage-clear') return { ok: false, reason: 'not-clear' };
  const nextIndex = game.stageIndex + 1;
  if (nextIndex >= STAGES.length) return { ok: false, reason: 'no-more-stages' };
  game.stageIndex = nextIndex;
  game.stage = instantiateStage(STAGES[nextIndex]);
  game.towers = [];
  game.enemies = [];
  game.projectiles = [];
  game.waveIndex = 0;
  game.waveState = 'intermission';
  game.waveTimer = 0;
  game.spawnQueue = [];
  game.status = 'playing';
  return { ok: true };
}

function towerCellCenter(game, tower) {
  const slot = game.stage.slots[tower.slotIndex];
  return { x: slot.x + 0.5, y: slot.y + 0.5 };
}

export function stepGame(game, dt) {
  if (game.status !== 'playing') return;
  game.elapsed += dt;
  const stg = game.stage;

  // 1) ウェーブ進行
  if (game.waveState === 'intermission') {
    game.waveTimer += dt;
    if (game.waveTimer >= INTERMISSION_TIME) {
      game.waveTimer = 0;
      game.waveState = 'active';
      game.spawnQueue = stg.waves[game.waveIndex].slice();
      emit(game, { type: 'wave-start', wave: game.waveIndex + 1, stage: game.stageIndex + 1 });
    }
  } else if (game.waveState === 'active') {
    game.waveTimer += dt;
    while (game.spawnQueue.length && game.spawnQueue[0].t <= game.waveTimer) {
      const entry = game.spawnQueue.shift();
      spawnEnemy(game, entry.kind);
    }
    if (game.spawnQueue.length === 0 && game.enemies.length === 0) {
      const bonus = Math.round(stg.waveClearBonus(game.waveIndex));
      game.gold += bonus;
      const isLastWave = game.waveIndex >= stg.waves.length - 1;
      const isLastStage = game.stageIndex >= STAGES.length - 1;
      if (isLastWave && isLastStage) {
        game.status = 'all-clear';
        emit(game, { type: 'all-clear' });
      } else if (isLastWave) {
        game.status = 'stage-clear';
        emit(game, { type: 'stage-clear', stage: game.stageIndex + 1 });
      } else {
        game.waveIndex += 1;
        game.waveState = 'intermission';
        game.waveTimer = 0;
      }
    }
  }

  if (game.status !== 'playing') return;

  // 2) 敵の移動・ゴール到達
  const survivors = [];
  for (const enemy of game.enemies) {
    enemy.distance += enemy.speed * dt;
    if (enemy.distance >= stg.pathLen) {
      game.life -= enemy.leak;
      emit(game, { type: 'life-lost', amount: enemy.leak, life: Math.max(0, game.life) });
      if (game.life <= 0) {
        game.life = 0;
        game.status = 'lost';
        emit(game, { type: 'lost' });
      }
    } else {
      survivors.push(enemy);
    }
  }
  game.enemies = survivors;

  if (game.status !== 'playing') return;

  // 3) タワーの索敵・発射
  for (const tower of game.towers) {
    tower.cooldown -= dt;
    if (tower.cooldown > 0) continue;
    const center = towerCellCenter(game, tower);
    let best = null;
    let bestDist = -1;
    for (const enemy of game.enemies) {
      const pos = enemyPos(stg, enemy);
      const dx = pos.x - center.x;
      const dy = pos.y - center.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= tower.range && enemy.distance > bestDist) {
        bestDist = enemy.distance;
        best = enemy;
      }
    }
    if (best) {
      const def = TOWER_TYPES[tower.type];
      game.projectiles.push({
        id: game._nextId++,
        x: center.x,
        y: center.y,
        targetId: best.id,
        type: tower.type,
        damage: tower.damage,
        speed: def.projectileSpeed,
        splashRadius: def.splashRadius,
        splashDamageMul: def.splashDamageMul,
      });
      tower.cooldown = 1 / tower.fireRate;
      emit(game, { type: 'shot', towerType: tower.type, x: center.x, y: center.y });
    }
  }

  // 4) 弾の移動・命中
  const remainingProjectiles = [];
  for (const proj of game.projectiles) {
    const target = game.enemies.find((e) => e.id === proj.targetId && !e.dead);
    if (!target) continue; // 目標消滅→自然消滅（フィズル）
    const pos = enemyPos(stg, target);
    const dx = pos.x - proj.x;
    const dy = pos.y - proj.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = proj.speed * dt;
    if (dist <= Math.max(step, 0.12)) {
      // 命中
      applyDamage(game, target, proj.damage, pos);
      if (proj.splashRadius > 0) {
        for (const other of game.enemies) {
          if (other.id === target.id || other.dead) continue;
          const op = enemyPos(stg, other);
          const ddx = op.x - pos.x;
          const ddy = op.y - pos.y;
          if (Math.sqrt(ddx * ddx + ddy * ddy) <= proj.splashRadius) {
            applyDamage(game, other, proj.damage * proj.splashDamageMul, op);
          }
        }
      }
    } else {
      proj.x += (dx / dist) * step;
      proj.y += (dy / dist) * step;
      remainingProjectiles.push(proj);
    }
  }
  game.projectiles = remainingProjectiles;
  game.enemies = game.enemies.filter((e) => !e.dead);
}

function applyDamage(game, enemy, dmg, pos) {
  if (enemy.dead) return;
  enemy.hp -= dmg;
  emit(game, { type: 'hit', enemyId: enemy.id, x: pos.x, y: pos.y });
  if (enemy.hp <= 0 && !enemy.dead) {
    enemy.dead = true;
    game.gold += enemy.reward;
    emit(game, { type: 'kill', enemyId: enemy.id, x: pos.x, y: pos.y, reward: enemy.reward });
  }
}

export function getEnemyRenderPos(game, enemy) {
  return enemyPos(game.stage, enemy);
}
