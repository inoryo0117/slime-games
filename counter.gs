/**
 * 遊ばれた回数カウンター（Google Apps Script・スプレッドシート紐付け）
 *
 * 設置手順
 *  1. Google スプレッドシートを新規作成する（名前は自由）。
 *  2. メニュー「拡張機能」→「Apps Script」を開く。
 *  3. 最初からあるコードを全部消して、このファイルの中身を貼り付け、保存する。
 *  4. 右上「デプロイ」→「新しいデプロイ」→ 歯車で種類「ウェブアプリ」を選ぶ。
 *  5. 「次のユーザーとして実行」＝自分、「アクセスできるユーザー」＝全員 にしてデプロイ
 *     （初回は権限の承認を求められるので許可する）。
 *  6. 表示された「ウェブアプリ」の URL（…/exec で終わるもの）をコピーする。
 *  7. index.html の  var COUNTER_URL = "";  の "" の中にその URL を貼り、公開する。
 *  ※ シート「counts」は無ければ自動で作られる（A列=ゲームID、B列=回数）。
 *  ※ コードを直したときは「デプロイを管理」→ 編集 → 新バージョン で更新する（URL は変わらない）。
 *  ※ 新しいゲームを足したら、下の KNOWN_IDS にもその id を足す。
 */

// 数えてよいゲームの id（これ以外は無視する）。外部リンクのゲームは入れない。
var KNOWN_IDS = ["slime-survivors", "chibi-survivors", "slime-tower", "slime-basket"];
var SHEET_NAME = "counts";

function doGet(e) {
  var p = (e && e.parameter) || {};
  var id = p.hit;
  if (id && /^[a-z0-9-]{1,40}$/.test(id) && KNOWN_IDS.indexOf(id) !== -1) {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      hit_(id);
    } finally {
      lock.releaseLock();
    }
  }
  return ContentService.createTextOutput(JSON.stringify(readAll_()))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function hit_(id) {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last > 0) {
    var ids = sh.getRange(1, 1, last, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === id) {
        var cell = sh.getRange(i + 1, 2);
        cell.setValue((Number(cell.getValue()) || 0) + 1);
        return;
      }
    }
  }
  sh.appendRow([id, 1]);
}

function readAll_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  var out = {};
  if (last > 0) {
    sh.getRange(1, 1, last, 2).getValues().forEach(function (r) {
      if (r[0] !== "") out[r[0]] = Number(r[1]) || 0;
    });
  }
  return out;
}
