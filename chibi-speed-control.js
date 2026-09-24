// speed-control.js — 倍速（×1→×2→×3）の切り替えとサブステップ実行。
// slime-survivors.html と test-survivors.mjs の両方から使う。DOM/Canvas には触れない。
//
// 倍速は dt を倍にせず、同じ dt で stepGame を speedMul 回呼ぶ
// （dt を倍にすると当たり判定が飛んでゲームが変質するため）。
// ロジック側（survivors-logic.js）はこの機能を知らない＝無改変。

import { stepGame } from './chibi-logic.js';

export const SPEED_STEPS = [1, 2, 3];

/* 次の倍率へ（×1→×2→×3→×1）。想定外の値は ×1 に戻す。 */
export function nextSpeed(speedMul) {
  const i = SPEED_STEPS.indexOf(speedMul);
  return SPEED_STEPS[(i + 1) % SPEED_STEPS.length];
}

/* 想定外の値を ×1 に丸める。 */
export function normalizeSpeed(v) {
  return SPEED_STEPS.includes(v) ? v : 1;
}

/* 1描画フレームぶん進める。playing 中は speedMul 回、それ以外は1回だけ stepGame を呼ぶ。
   status が 'playing' 以外になったら残りのサブステップは捨てる。
   getInput(i) は各サブステップの入力を返し、afterStep(i) は各 stepGame の直後に呼ばれる。
   戻り値は実際に stepGame を呼んだ回数。 */
export function advanceFrame(game, dt, speedMul, getInput, afterStep) {
  const steps = game.status === 'playing' ? normalizeSpeed(speedMul) : 1;
  let done = 0;
  for (let i = 0; i < steps; i++) {
    stepGame(game, dt, getInput(i));
    done += 1;
    if (afterStep) afterStep(i);
    if (game.status !== 'playing') break;
  }
  return done;
}
