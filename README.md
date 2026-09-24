# スライムのゲーム置き場 / Slime Games

ダウンロードも登録もいらない、短時間で遊べるブラウザゲームです。スマホでもPCでも、開いたらすぐ始まります。

**▶ https://inoryo0117.github.io/slime-games/**

Free, bite-sized browser games. No download, no sign-up — they run right in your browser, on phone or PC.

## 収録

| ゲーム | 内容 |
|---|---|
| [スライム・サバイバーズ](slime-survivors.html) | 見下ろし視点の自動攻撃サバイバー。ゆび1本で動かすだけ。1ラン約8分、7分でボスが出ます。難易度3段階 |
| [ちびキャラ・サバイバーズ](chibi-survivors.html) | スライム・サバイバーズの見た目違い。主人公が8方向に歩くドット絵のちびキャラ。ルールは同じ |
| [スライム防衛隊タワーディフェンス](slime-tower.html) | 道の脇にタワーを建てて迎え撃つ。全4ステージ |
| [スライム・イン・かご](slime-basket.html) | 動くかごにスライムを入れるスコアアタック。3回落としたら終わり |

## つくり

- 素のHTML5 Canvas 2D。ゲームエンジンもフレームワークも使っていません
- 外部への通信なし。読み込みが終わればオフラインでも動きます
- タッチとマウスの両方に対応
- ゲームロジックは描画から切り離してあり（`survivors-logic.js` / `td-logic.js`）、自動プレイのボットを回して挙動とバランスを検証しています

## 画像素材

`assets/kenney_tower-defense-top-down/` は [Kenney](https://kenney.nl/assets/tower-defense-top-down) の Tower Defense (top-down) Pack（CC0）です。同梱の `License.txt` を参照してください。`chibi-sprites.png`（ちびキャラの絵）は画像生成AIで描かせたものをドット単位で整えたものです（正面の2コマだけは手描き）。それ以外のグラフィックはすべてコードで描いています。
