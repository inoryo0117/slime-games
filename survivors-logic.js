// survivors-logic.js — スライム・サバイバーズのゲームロジック（DOM非依存）
//
// 設計方針（td-logic.js と同じ流儀）:
//  - Canvas / Image / AudioContext やブラウザのグローバルオブジェクトに一切触れない。
//    Node からそのまま import してテストできる（test-survivors.mjs 参照）。
//  - 乱数はブラウザ組み込みの乱数関数を直接呼ばず、シード可能な mulberry32 のみを使う。
//  - stepGame(game, dt, input) が唯一の時間進行関数。
//  - 見た目・音は game.events に積まれるイベントを描画側が drainEvents() で
//    取り出して処理する。ロジック側はそれ以上関与しない。
//  - game オブジェクトのうち _ で始まるフィールドはロジック内部の実装詳細
//    （描画側の契約には含まれない）。契約フィールドは仕様書 §7 のとおり。

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
// 定数（仕様書 §1・§2 準拠）
// ---------------------------------------------------------------------------
export const WORLD = 2400;
export const RUN_TIME = 480;
export const BOSS_TIME = 420;

const MAX_ENEMIES = 260;
const MAX_GEMS = 900;
const GEM_LIFESPAN = 15; // 拾われなかったかけらは、この秒数後に自動でXPに入る（見た目改修 2026-09-24）
const MAX_PROJECTILES = 600; // テストのアサーション2で要求される上限（仕様§5/6には明記なし）
const MAX_STRIKES = 40;      // 同上
const MAX_EVENTS = 300;      // 同上

const SPAWN_RING_R = 460;
const DESPAWN_R = 1000;

// hane（はね）の左右振れの周波数・振幅。仕様書は「時間の正弦波・個体ごとに
// 位相ランダム」とだけ書かれ、周期の数値までは指定していない。周期1.2秒
// （振り切れが速すぎず遅すぎない値）を採用した。振幅は仕様どおり±40°。
const HANE_WOBBLE_PERIOD = 1.2;
const HANE_WOBBLE_FREQ = (Math.PI * 2) / HANE_WOBBLE_PERIOD;
const HANE_WOBBLE_AMP = (40 * Math.PI) / 180;

// ボスの周囲に湧く poyo の距離。仕様書は「自分の周囲に」とだけ書かれ、
// 具体的な半径の指定は無い。ボス半径46に少し余裕を持たせた40〜60を採用した。
const BOSS_MINION_MIN_R = 40;
const BOSS_MINION_R_RANGE = 20;

/* 難易度。2026-09-23 にボット16シード×無敵なしで測って決めた実値。
   むずかしい＝全係数1.0＝この日より前のバランスそのもの（クリア到達0/16）。
   pdmg = プレイヤーの与ダメージ倍率（applyDamage で一括して掛ける）。 */
export const DIFFS = {
  easy:   { key: 'easy',   name: 'やさしい',   ehp: 0.65, dens: 0.80, edmg: 0.90, xp: 2.0, pdmg: 1.95, tag: 'クリアできる' },
  normal: { key: 'normal', name: 'ふつう',     ehp: 0.70, dens: 0.85, edmg: 0.70, xp: 1.6, pdmg: 1.8, tag: 'ちょうどいい' },
  hard:   { key: 'hard',   name: 'むずかしい', ehp: 1.00, dens: 1.00, edmg: 1.00, xp: 1.0, pdmg: 1.0, tag: 'これまでのバランス' },
};
export const DIFF_ORDER = ['easy', 'normal', 'hard'];

// ---------------------------------------------------------------------------
// 敵の基礎パラメータ（仕様書 §5）
// ---------------------------------------------------------------------------
export const ENEMY_TYPES = {
  poyo: { label: 'ぽよ', hp: 10, speed: 46, dmg: 6, r: 12, xp: 1 },
  tsubu: { label: 'つぶ', hp: 6, speed: 92, dmg: 4, r: 9, xp: 1 },
  mochi: { label: 'もち', hp: 60, speed: 30, dmg: 12, r: 20, xp: 4 },
  hane: { label: 'はね', hp: 20, speed: 70, dmg: 7, r: 13, xp: 2 },
  oyamochi: { label: 'おやもち', hp: 2500, speed: 34, dmg: 20, r: 46, xp: 60, boss: true },
};

const SPAWN_TABLE = [
  { until: 60, interval: 1.90, count: 1, weights: [['poyo', 1]] },
  { until: 150, interval: 1.05, count: 1, weights: [['poyo', 0.7], ['tsubu', 0.3]] },
  { until: 260, interval: 0.80, count: 2, weights: [['poyo', 0.45], ['tsubu', 0.35], ['hane', 0.20]] },
  { until: 360, interval: 0.52, count: 2, weights: [['poyo', 0.35], ['tsubu', 0.30], ['hane', 0.20], ['mochi', 0.15]] },
  { until: Infinity, interval: 0.42, count: 3, weights: [['poyo', 0.30], ['tsubu', 0.30], ['hane', 0.22], ['mochi', 0.18]] },
];

function getSpawnTier(t) {
  for (const tier of SPAWN_TABLE) {
    if (t < tier.until) return tier;
  }
  return SPAWN_TABLE[SPAWN_TABLE.length - 1];
}

// ---------------------------------------------------------------------------
// 武器（仕様書 §6）
// 各レベルの数値は「レベルアップ時」の差分説明を、Lv1の初期性能から
// 累積させて解釈したもの（例: bubble Lv3は Lv2の弾数構成を保ったまま dmgだけ12）。
// ---------------------------------------------------------------------------
const BUBBLE_LEVELS = [
  null,
  { shots: 1, angles: [0], dmg: 8, cd: 0.90, speed: 260, pierce: 0, life: 2.0,
    desc: '近くの敵へ ぽんっと弾をとばす' },
  { shots: 2, angles: [-9, 9], dmg: 8, cd: 0.90, speed: 260, pierce: 0, life: 2.0,
    desc: '弾が2発にふえる' },
  { shots: 2, angles: [-9, 9], dmg: 12, cd: 0.90, speed: 260, pierce: 0, life: 2.0,
    desc: '弾が1.5倍つよくなる' },
  { shots: 2, angles: [-9, 9], dmg: 12, cd: 0.70, speed: 260, pierce: 0, life: 2.0,
    desc: '弾をとばす間隔が短くなる' },
  { shots: 3, angles: [-9, 0, 9], dmg: 12, cd: 0.70, speed: 260, pierce: 1, life: 2.0,
    desc: '弾が3発になり 敵を1体つらぬく' },
];

const RING_LEVELS = [
  null,
  { petals: 2, radius: 62, angSpeed: 2.2, dmg: 6,
    desc: '花びら2枚が まわりを回って 触れた敵に当たる' },
  { petals: 3, radius: 62, angSpeed: 2.2, dmg: 6, desc: '花びらが3枚にふえる' },
  { petals: 3, radius: 62, angSpeed: 2.2, dmg: 9, desc: '花びらが1.5倍つよくなる' },
  { petals: 3, radius: 84, angSpeed: 2.8, dmg: 9, desc: 'わっかが大きくなり 回るのが速くなる' },
  { petals: 5, radius: 84, angSpeed: 2.8, dmg: 9, desc: '花びらが5枚にふえる' },
];

const KONPEITO_LEVELS = [
  null,
  { drops: 1, dmg: 18, cd: 2.2, spawnR: 220, impactR: 52,
    desc: 'ときどき 空からこんぺいとうが落ちて その場所の敵に当たる' },
  { drops: 2, dmg: 18, cd: 2.2, spawnR: 220, impactR: 52, desc: '落ちる場所が2か所にふえる' },
  { drops: 2, dmg: 26, cd: 2.2, spawnR: 220, impactR: 52, desc: 'こんぺいとうが約1.4倍つよくなる' },
  { drops: 2, dmg: 26, cd: 1.6, spawnR: 220, impactR: 52, desc: '落ちてくる間隔が短くなる' },
  { drops: 3, dmg: 26, cd: 1.6, spawnR: 220, impactR: 66, desc: '落ちる場所が3か所になり 当たる範囲も広がる' },
];

const MAME_LEVELS = [
  null,
  { interval: 0.5, life: 3.0, dmg: 10, splash: false,
    desc: '通ったあとに まめを置く。ふんだ敵に当たる' },
  { interval: 0.5, life: 4.5, dmg: 10, splash: false, desc: 'まめが長く残るようになる' },
  { interval: 0.5, life: 4.5, dmg: 15, splash: false, desc: 'まめが1.5倍つよくなる' },
  { interval: 0.35, life: 4.5, dmg: 15, splash: false, desc: 'まめを置く間隔が短くなる' },
  { interval: 0.35, life: 4.5, dmg: 15, splash: true, splashR: 40, splashDmg: 10,
    desc: 'まめがはじけて まわりにも当たる' },
];

export const WEAPONS = {
  bubble: { label: 'しゃぼん', maxLevel: 5, levels: BUBBLE_LEVELS },
  ring: { label: 'わっか', maxLevel: 5, levels: RING_LEVELS },
  konpeito: { label: 'こんぺいとう', maxLevel: 5, levels: KONPEITO_LEVELS },
  mame: { label: 'まめ', maxLevel: 5, levels: MAME_LEVELS },
};

export const PASSIVES = {
  boots: { label: 'あしばや', maxLevel: 5, perLevel: 0.12, desc: '動くのが すこし速くなる' },
  magnet: { label: 'じしゃく', maxLevel: 5, perLevel: 0.30, desc: 'かけらを ひろえる範囲が広がる' },
  heart: { label: 'はーと', maxLevel: 5, perLevel: 15, desc: '最大HPが15ふえて そのぶん回復する' },
  charm: { label: 'おまもり', maxLevel: 5, perLevel: 0.10, desc: 'ぜんぶの武器が 1割つよくなる' },
};

// ---------------------------------------------------------------------------
// ゲーム状態
// ---------------------------------------------------------------------------
function need(level) {
  return 5 + (level - 1) * 4;
}

export function createGame(seed = 1, diffKey = 'normal') {
  const rng = mulberry32(seed >>> 0);
  const diff = DIFFS[diffKey] || DIFFS.normal;
  const game = {
    seed,
    diffKey: diff.key,
    diff,
    t: 0,
    status: 'playing', // 'playing' | 'levelup' | 'clear' | 'gameover'
    player: {
      x: WORLD / 2,
      y: WORLD / 2,
      hp: 100,
      maxHp: 100,
      level: 1,
      xp: 0,
      xpNeed: need(1),
      speed: 150,
      r: 13,
      invuln: 0,
      facing: { x: 0, y: 1 },
    },
    enemies: [],
    projectiles: [],
    orbiters: [],
    strikes: [],
    gems: [],
    owned: { bubble: 1 },
    offers: [],
    kills: 0,
    events: [],
    // --- 以下は内部実装用（描画側の契約には含まれない） ---
    _rng: rng,
    _nextId: 1,
    _spawnTimer: SPAWN_TABLE[0].interval / diff.dens,
    _bossSpawned: false,
    _weaponState: { bubble: { cd: 0 }, ring: { angle: 0 }, konpeito: { cd: 0 }, mame: { cd: 0 } },
    _ringHits: new Map(),
  };
  return game;
}

export function drainEvents(game) {
  const ev = game.events;
  game.events = [];
  return ev;
}

function emit(game, event) {
  if (game.events.length < MAX_EVENTS) game.events.push(event);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// 敵の生成
// ---------------------------------------------------------------------------
function spawnEnemyAt(game, type, x, y) {
  const def = ENEMY_TYPES[type];
  const hpMul = 1 + game.t / 120;
  const hp = Math.round(def.hp * hpMul * game.diff.ehp);
  const enemy = { id: game._nextId++, type, x, y, hp, maxHp: hp, r: def.r, hitFlash: 0 };
  if (type === 'hane') enemy._phase = game._rng() * Math.PI * 2;
  if (type === 'oyamochi') enemy._bossTimer = 0;
  game.enemies.push(enemy);
  return enemy;
}

function spawnEnemyOnRing(game, type) {
  const ang = game._rng() * Math.PI * 2;
  const x = game.player.x + Math.cos(ang) * SPAWN_RING_R;
  const y = game.player.y + Math.sin(ang) * SPAWN_RING_R;
  return spawnEnemyAt(game, type, x, y);
}

function spawnMinionNearBoss(game, boss) {
  const ang = game._rng() * Math.PI * 2;
  const dist = BOSS_MINION_MIN_R + game._rng() * BOSS_MINION_R_RANGE;
  const x = boss.x + Math.cos(ang) * dist;
  const y = boss.y + Math.sin(ang) * dist;
  spawnEnemyAt(game, 'poyo', x, y);
}

function pickWeighted(rng, weights) {
  let total = 0;
  for (const [, w] of weights) total += w;
  let r = rng() * total;
  for (const [type, w] of weights) {
    r -= w;
    if (r <= 0) return type;
  }
  return weights[weights.length - 1][0];
}

function updateEnemySpawning(game, dt) {
  game._spawnTimer -= dt;
  while (game._spawnTimer <= 0) {
    const tier = getSpawnTier(game.t);
    if (game.enemies.length < MAX_ENEMIES) {
      for (let i = 0; i < tier.count; i++) {
        if (game.enemies.length >= MAX_ENEMIES) break;
        const type = pickWeighted(game._rng, tier.weights);
        spawnEnemyOnRing(game, type);
      }
    }
    game._spawnTimer += tier.interval / game.diff.dens;
  }
}

function updateBossTrigger(game) {
  if (!game._bossSpawned && game.t >= BOSS_TIME) {
    game._bossSpawned = true;
    spawnEnemyOnRing(game, 'oyamochi');
    emit(game, { type: 'boss' });
  }
}

// ---------------------------------------------------------------------------
// プレイヤーの移動
// ---------------------------------------------------------------------------
function updatePlayerMovement(game, dt, input) {
  const p = game.player;
  p.invuln = Math.max(0, p.invuln - dt);

  let mx = input && typeof input.mx === 'number' ? input.mx : 0;
  let my = input && typeof input.my === 'number' ? input.my : 0;
  const rawMag = Math.hypot(mx, my);
  if (rawMag > 1e-4) {
    p.facing = { x: mx / rawMag, y: my / rawMag };
  }
  if (rawMag > 1) {
    mx /= rawMag;
    my /= rawMag;
  }
  const bootsMul = 1 + (game.owned.boots || 0) * 0.12;
  const speed = p.speed * bootsMul;
  p.x = clamp(p.x + mx * speed * dt, 0, WORLD);
  p.y = clamp(p.y + my * speed * dt, 0, WORLD);
}

// ---------------------------------------------------------------------------
// 敵の移動・分離・間引き
// ---------------------------------------------------------------------------
function updateEnemyMovement(game, dt) {
  const p = game.player;
  for (const e of game.enemies) {
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    const def = ENEMY_TYPES[e.type];
    let vx, vy;
    if (e.type === 'hane') {
      const baseAngle = Math.atan2(p.y - e.y, p.x - e.x);
      const wobble = Math.sin(game.t * HANE_WOBBLE_FREQ + e._phase) * HANE_WOBBLE_AMP;
      const ang = baseAngle + wobble;
      vx = Math.cos(ang) * def.speed;
      vy = Math.sin(ang) * def.speed;
    } else {
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      vx = (dx / dist) * def.speed;
      vy = (dy / dist) * def.speed;
    }
    e.x += vx * dt;
    e.y += vy * dt;
    if (e.type === 'oyamochi') {
      e._bossTimer += dt;
      while (e._bossTimer >= 4) {
        e._bossTimer -= 4;
        for (let k = 0; k < 3; k++) {
          if (game.enemies.length < MAX_ENEMIES) spawnMinionNearBoss(game, e);
        }
      }
    }
  }
}

// 敵同士の弱い押し出し（空間グリッドで間引く。詳細は仕様書§5「敵同士は弱い押し出しをする」）。
function resolveEnemySeparation(game, dt) {
  const enemies = game.enemies;
  const n = enemies.length;
  if (n < 2) return;
  const cellSize = 80;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const e = enemies[i];
    const cx = Math.floor(e.x / cellSize);
    const cy = Math.floor(e.y / cellSize);
    const key = cx + ',' + cy;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }
  const pushX = new Float64Array(n);
  const pushY = new Float64Array(n);
  const offsets = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 1]];
  for (const [key, bucket] of grid) {
    const parts = key.split(',');
    const cx = parseInt(parts[0], 10);
    const cy = parseInt(parts[1], 10);
    for (const [ox, oy] of offsets) {
      if (ox === 0 && oy === 0) {
        for (let a = 0; a < bucket.length; a++) {
          for (let b = a + 1; b < bucket.length; b++) {
            applySeparationPush(enemies, bucket[a], bucket[b], pushX, pushY, dt);
          }
        }
      } else {
        const nbucket = grid.get((cx + ox) + ',' + (cy + oy));
        if (!nbucket) continue;
        for (let a = 0; a < bucket.length; a++) {
          for (let b = 0; b < nbucket.length; b++) {
            applySeparationPush(enemies, bucket[a], nbucket[b], pushX, pushY, dt);
          }
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    enemies[i].x += pushX[i];
    enemies[i].y += pushY[i];
  }
}

function applySeparationPush(enemies, i, j, pushX, pushY, dt) {
  const a = enemies[i];
  const b = enemies[j];
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (dist >= minDist) return;
  if (dist < 1e-6) {
    // 完全に重なった場合の決定的なフォールバック方向（乱数関数は使わない）。
    const h = ((a.id * 2654435761) ^ (b.id * 2246822519)) >>> 0;
    const ang = ((h % 3600) / 3600) * Math.PI * 2;
    dx = Math.cos(ang);
    dy = Math.sin(ang);
    dist = 1;
  }
  const nx = dx / dist;
  const ny = dy / dist;
  const amount = 40 * dt;
  pushX[i] -= nx * amount;
  pushY[i] -= ny * amount;
  pushX[j] += nx * amount;
  pushY[j] += ny * amount;
}

function cullFarEnemies(game) {
  const p = game.player;
  const limitSq = DESPAWN_R * DESPAWN_R;
  game.enemies = game.enemies.filter((e) => {
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    return dx * dx + dy * dy <= limitSq;
  });
}

// ---------------------------------------------------------------------------
// プレイヤーと敵の接触
// ---------------------------------------------------------------------------
function resolvePlayerEnemyCollision(game) {
  const p = game.player;
  if (p.invuln > 0) return;
  for (const e of game.enemies) {
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < e.r + p.r) {
      const dmg = ENEMY_TYPES[e.type].dmg * game.diff.edmg;
      p.hp -= dmg;
      p.invuln = 0.6;
      emit(game, { type: 'hurt', x: p.x, y: p.y, dmg });
      if (p.hp <= 0) {
        p.hp = 0;
        game.status = 'gameover';
        emit(game, { type: 'gameover' });
      }
      break; // 接触判定は1フレームにつき1回だけ（仕様書§4）
    }
  }
}

// ---------------------------------------------------------------------------
// 武器
// ---------------------------------------------------------------------------
function charmMultiplier(game) {
  const lvl = game.owned.charm || 0;
  return 1 + lvl * 0.10;
}

function nearestEnemy(game) {
  let best = null;
  let bestD = Infinity;
  const p = game.player;
  for (const e of game.enemies) {
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function applyDamage(game, enemy, dmg, x, y) {
  enemy.hp -= dmg * game.diff.pdmg;
  enemy.hitFlash = 0.12;
  emit(game, { type: 'hit', x, y, dmg });
}

function fireBubble(game, lvl, target) {
  const p = game.player;
  const baseAngle = Math.atan2(target.y - p.y, target.x - p.x);
  const dmgMul = charmMultiplier(game);
  for (let i = 0; i < lvl.shots; i++) {
    if (game.projectiles.length >= MAX_PROJECTILES) break;
    const ang = baseAngle + ((lvl.angles[i] || 0) * Math.PI) / 180;
    game.projectiles.push({
      id: game._nextId++,
      kind: 'bubble',
      x: p.x,
      y: p.y,
      r: 6,
      vx: Math.cos(ang) * lvl.speed,
      vy: Math.sin(ang) * lvl.speed,
      life: lvl.life,
      _dmg: lvl.dmg * dmgMul,
      _pierceLeft: lvl.pierce,
      _hit: new Set(),
      _splash: null,
    });
  }
}

function fireKonpeito(game, lvl) {
  const p = game.player;
  const dmgMul = charmMultiplier(game);
  for (let i = 0; i < lvl.drops; i++) {
    const ang = game._rng() * Math.PI * 2;
    const dist = Math.sqrt(game._rng()) * lvl.spawnR;
    const x = p.x + Math.cos(ang) * dist;
    const y = p.y + Math.sin(ang) * dist;
    if (game.strikes.length >= MAX_STRIKES) game.strikes.shift();
    game.strikes.push({ x, y, r: lvl.impactR, life: 0.35 });
    emit(game, { type: 'strike', x, y, r: lvl.impactR });
    const rSq = lvl.impactR * lvl.impactR;
    for (const e of game.enemies) {
      const dx = e.x - x;
      const dy = e.y - y;
      if (dx * dx + dy * dy <= rSq) {
        applyDamage(game, e, lvl.dmg * dmgMul, x, y);
      }
    }
  }
}

function fireMame(game, lvl) {
  const p = game.player;
  const dmgMul = charmMultiplier(game);
  const dirx = -p.facing.x;
  const diry = -p.facing.y;
  const offset = p.r + 8;
  if (game.projectiles.length >= MAX_PROJECTILES) return;
  game.projectiles.push({
    id: game._nextId++,
    kind: 'mame',
    x: p.x + dirx * offset,
    y: p.y + diry * offset,
    r: 8,
    vx: 0,
    vy: 0,
    life: lvl.life,
    _dmg: lvl.dmg * dmgMul,
    _pierceLeft: Infinity, // mame は貫通制限なし（同一敵には1回だけ）
    _hit: new Set(),
    _splash: lvl.splash ? { r: lvl.splashR, dmg: lvl.splashDmg * dmgMul } : null,
  });
}

function updateWeaponsFiring(game, dt) {
  const ws = game._weaponState;
  const owned = game.owned;
  if (owned.bubble) {
    ws.bubble.cd -= dt;
    if (ws.bubble.cd <= 0) {
      const lvl = BUBBLE_LEVELS[owned.bubble];
      const target = nearestEnemy(game);
      if (target) {
        fireBubble(game, lvl, target);
        emit(game, { type: 'shot', x: game.player.x, y: game.player.y });
      }
      ws.bubble.cd += lvl.cd;
    }
  }
  if (owned.konpeito) {
    ws.konpeito.cd -= dt;
    if (ws.konpeito.cd <= 0) {
      const lvl = KONPEITO_LEVELS[owned.konpeito];
      fireKonpeito(game, lvl);
      ws.konpeito.cd += lvl.cd;
    }
  }
  if (owned.mame) {
    ws.mame.cd -= dt;
    if (ws.mame.cd <= 0) {
      const lvl = MAME_LEVELS[owned.mame];
      fireMame(game, lvl);
      ws.mame.cd += lvl.interval;
    }
  }
}

function updateProjectiles(game, dt) {
  const remaining = [];
  for (const proj of game.projectiles) {
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    proj.life -= dt;
    let alive = proj.life > 0;
    if (alive) {
      for (const e of game.enemies) {
        if (proj._hit.has(e.id)) continue;
        const dx = e.x - proj.x;
        const dy = e.y - proj.y;
        const rr = (proj.r + e.r) * (proj.r + e.r);
        if (dx * dx + dy * dy <= rr) {
          proj._hit.add(e.id);
          applyDamage(game, e, proj._dmg, proj.x, proj.y);
          if (proj._splash) {
            const sr = proj._splash.r * proj._splash.r;
            for (const other of game.enemies) {
              if (other.id === e.id) continue;
              const ddx = other.x - proj.x;
              const ddy = other.y - proj.y;
              if (ddx * ddx + ddy * ddy <= sr) {
                applyDamage(game, other, proj._splash.dmg, proj.x, proj.y);
              }
            }
          }
          if (proj.kind === 'bubble') {
            if (proj._pierceLeft > 0) {
              proj._pierceLeft -= 1;
            } else {
              alive = false;
              break;
            }
          }
        }
      }
    }
    if (alive) remaining.push(proj);
  }
  game.projectiles = remaining;
}

function updateOrbitersAndCollision(game, dt) {
  const owned = game.owned;
  if (!owned.ring) {
    game.orbiters = [];
    return;
  }
  const lvl = RING_LEVELS[owned.ring];
  game._weaponState.ring.angle += lvl.angSpeed * dt;
  const p = game.player;
  const dmgMul = charmMultiplier(game);
  const orbiters = [];
  const hitMap = game._ringHits;
  const petalR = 10; // 仕様書に花びら自体の当たり半径の明記が無いため採用した値
  for (let i = 0; i < lvl.petals; i++) {
    const angle = game._weaponState.ring.angle + i * ((Math.PI * 2) / lvl.petals);
    const x = p.x + Math.cos(angle) * lvl.radius;
    const y = p.y + Math.sin(angle) * lvl.radius;
    orbiters.push({ angle, x, y, r: petalR });
    for (const e of game.enemies) {
      const dx = e.x - x;
      const dy = e.y - y;
      const hitRR = (petalR + e.r) * (petalR + e.r);
      if (dx * dx + dy * dy <= hitRR) {
        const last = hitMap.has(e.id) ? hitMap.get(e.id) : -999;
        if (game.t - last >= 0.45) {
          hitMap.set(e.id, game.t);
          applyDamage(game, e, lvl.dmg * dmgMul, x, y);
        }
      }
    }
  }
  game.orbiters = orbiters;
}

function updateStrikes(game, dt) {
  const remaining = [];
  for (const s of game.strikes) {
    s.life -= dt;
    if (s.life > 0) remaining.push(s);
  }
  game.strikes = remaining;
}

// ---------------------------------------------------------------------------
// 撃破・XP・ジェム・レベルアップ
// ---------------------------------------------------------------------------
function generateOffers(game) {
  const owned = game.owned;
  const weaponKeys = Object.keys(WEAPONS);
  const passiveKeys = Object.keys(PASSIVES);
  const ownedWeaponCount = weaponKeys.filter((k) => owned[k]).length;
  const pool = [];
  for (const k of weaponKeys) {
    if (owned[k]) {
      if (owned[k] < 5) pool.push(k);
    } else if (ownedWeaponCount < 4) {
      pool.push(k);
    }
  }
  for (const k of passiveKeys) {
    if (owned[k]) {
      if (owned[k] < 5) pool.push(k);
    } else {
      pool.push(k);
    }
  }
  if (pool.length === 0) {
    return [{ key: 'heal', label: 'かいふく', desc: 'HPを30回復' }];
  }
  const picked = pickN(game._rng, pool, 3);
  return picked.map((k) => {
    const curLevel = owned[k] || 0;
    const targetLevel = curLevel + 1;
    let label, desc;
    if (WEAPONS[k]) {
      label = WEAPONS[k].label;
      desc = WEAPONS[k].levels[targetLevel].desc;
    } else {
      label = PASSIVES[k].label;
      desc = PASSIVES[k].desc;
    }
    return { key: k, label, desc, level: targetLevel };
  });
}

function pickN(rng, arr, n) {
  const pool = arr.slice();
  const out = [];
  while (pool.length && out.length < n) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function creditXp(game, amount) {
  const p = game.player;
  p.xp += amount;
  let leveled = false;
  while (p.xp >= p.xpNeed) {
    p.xp -= p.xpNeed;
    p.level += 1;
    p.xpNeed = need(p.level);
    leveled = true;
  }
  if (leveled && game.status === 'playing') {
    game.status = 'levelup';
    game.offers = generateOffers(game);
    emit(game, { type: 'levelup', level: p.level });
  }
}

function spawnGem(game, x, y, value) {
  game.gems.push({ id: game._nextId++, x, y, value, bornT: game.t });
  if (game.gems.length > MAX_GEMS) {
    const removed = game.gems.shift();
    creditXp(game, removed.value);
  }
}

function cleanupDeadEnemies(game) {
  const survivors = [];
  for (const e of game.enemies) {
    if (e.hp <= 0) {
      const def = ENEMY_TYPES[e.type];
      game.kills += 1;
      emit(game, { type: 'pop', x: e.x, y: e.y, enemyType: e.type });
      spawnGem(game, e.x, e.y, def.xp * game.diff.xp);
      game._ringHits.delete(e.id);
      if (e.type === 'oyamochi') {
        game.status = 'clear';
        emit(game, { type: 'clear' });
      }
    } else {
      survivors.push(e);
    }
  }
  game.enemies = survivors;
}

function updateGemsAndPickup(game, dt) {
  const p = game.player;
  const pickupR = 64 * (1 + (game.owned.magnet || 0) * 0.30);
  const remaining = [];
  for (const g of game.gems) {
    if (game.t - g.bornT >= GEM_LIFESPAN) {
      creditXp(game, g.value);
      continue;
    }
    let dx = p.x - g.x;
    let dy = p.y - g.y;
    let dist = Math.hypot(dx, dy);
    if (dist <= pickupR && dist > 0) {
      const step = Math.min(dist, 300 * dt);
      g.x += (dx / dist) * step;
      g.y += (dy / dist) * step;
      dx = p.x - g.x;
      dy = p.y - g.y;
      dist = Math.hypot(dx, dy);
    }
    if (dist <= 14) {
      creditXp(game, g.value);
      emit(game, { type: 'gem', x: g.x, y: g.y });
    } else {
      remaining.push(g);
    }
  }
  game.gems = remaining;
}

// ---------------------------------------------------------------------------
// レベルアップの選択
// ---------------------------------------------------------------------------
export function chooseUpgrade(game, key) {
  if (game.status !== 'levelup') return false;
  const offer = game.offers.find((o) => o.key === key);
  if (!offer) return false;
  if (key === 'heal') {
    game.player.hp = Math.min(game.player.maxHp, game.player.hp + 30);
    emit(game, { type: 'heal', amount: 30 });
  } else if (WEAPONS[key]) {
    game.owned[key] = (game.owned[key] || 0) + 1;
  } else if (PASSIVES[key]) {
    game.owned[key] = (game.owned[key] || 0) + 1;
    if (key === 'heart') {
      const add = PASSIVES.heart.perLevel;
      game.player.maxHp += add;
      game.player.hp += add;
    }
  }
  game.offers = [];
  game.status = 'playing';
  return true;
}

// ---------------------------------------------------------------------------
// メインループ
// ---------------------------------------------------------------------------
export function stepGame(game, dt, input) {
  if (game.status !== 'playing') return;
  dt = Math.min(dt, 1 / 30);
  game.t += dt;

  updatePlayerMovement(game, dt, input);
  updateBossTrigger(game);
  updateEnemySpawning(game, dt);
  updateEnemyMovement(game, dt);
  resolveEnemySeparation(game, dt);
  cullFarEnemies(game);
  resolvePlayerEnemyCollision(game);
  if (game.status !== 'playing') return;

  updateWeaponsFiring(game, dt);
  updateProjectiles(game, dt);
  updateOrbitersAndCollision(game, dt);
  updateStrikes(game, dt);
  cleanupDeadEnemies(game);
  updateGemsAndPickup(game, dt);
}

// ---------------------------------------------------------------------------
// 決定性テスト用ハッシュ
// ---------------------------------------------------------------------------
export function stateHash(game) {
  const r = (n) => Math.round(n * 100) / 100;
  let s = `t:${r(game.t)}|st:${game.status}`;
  s += `|p:${r(game.player.x)},${r(game.player.y)},${r(game.player.hp)},${game.player.level},${r(game.player.xp)}`;
  s += `|e:${game.enemies.length}`;
  for (const e of game.enemies) s += `,${e.id}:${r(e.x)}:${r(e.y)}:${r(e.hp)}`;
  s += `|pr:${game.projectiles.length}`;
  for (const p of game.projectiles) s += `,${p.id}:${r(p.x)}:${r(p.y)}`;
  s += `|g:${game.gems.length}`;
  for (const g of game.gems) s += `,${g.id}:${r(g.x)}:${r(g.y)}`;
  s += `|k:${game.kills}`;
  return s;
}
