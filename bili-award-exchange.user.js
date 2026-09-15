// ==UserScript==
// @name         B站活动奖励自动领取
// @namespace    https://github.com/Xiao-Jiang-233
// @version      1.0.1
// @description  在 B 站「奖励领取」页自动卡点抢领：默认 23:59:00（B 站服务器时间）开始轮询任务状态，一旦变为「可领取」立刻自动点击领取并按秒重试，成功后响铃 + 标题提醒；命中风控验证码时停止并提醒人工处理。
// @author       Xiao-Jiang-233 (https://github.com/Xiao-Jiang-233)
// @match        https://www.bilibili.com/blackboard/era/award-exchange.html
// @match        https://www.bilibili.com/blackboard/era/award-exchange.html*
// @homepageURL  https://github.com/Xiao-Jiang-233/bili-award-exchange
// @downloadURL  https://cdn.jsdelivr.net/gh/Xiao-Jiang-233/bili-award-exchange@main/bili-award-exchange.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/Xiao-Jiang-233/bili-award-exchange@main/bili-award-exchange.user.js
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 可调参数 ================= */
  var POLL_MS      = 1500;   // 轮询任务状态的基准间隔（毫秒）
  var JITTER       = 0.5;    // 间隔随机抖动比例（±50%），固定节奏容易被风控
  var CLICK_MS     = 1000;   // 两次「领取」之间的间隔：贴着页面 handleReceiveClick 的 1 秒节流上限走
  var BLIND        = true;   // 卡点窗口内不等服务端状态，直接盲点（你手动抢也是这么点的）
  var BLIND_MIN    = 2;      // 盲点持续多久（分钟，从开抢时刻算起）：0 点放量正好在这一段里
  var MAX_ATTEMPTS = 200;    // 最多点击次数，避免无限重试
  var MAX_MINUTES  = 10;     // 单轮最长运行时长（分钟）
  var MAX_FAILS    = 10;     // 连续查询失败（风控/网络）多少次后放弃
  var BACKOFF_MAX  = 30000;  // 失败退避上限（毫秒）
  var RESET_GRACE_MIN = 30;  // 距次日 0 点这么多分钟内，「每日库存已达上限」不停，继续等刷新
  var GRAB_MIN     = 10;     // 卡点窗口：从开抢时刻起这么多分钟内完全无视库存判定，只认 status
  var POST_MIN     = 30;     // 开抢时刻刚过这么多分钟内打开页面，视为「今天还能抢」，立即开抢而不是等一整天
  var CAP_CONFIRM  = 3;      // 「每日库存已达上限」连续确认这么多次才停，防一次异常响应把整晚废掉
  var TIME_KEY     = 'bae.start';
  /* =========================================== */

  var TASK_ID = new URL(location.href).searchParams.get('task_id');
  if (!TASK_ID) return;

  var INFO_API = 'https://api.bilibili.com/x/activity_components/mission/info?task_id=' + encodeURIComponent(TASK_ID);
  var NOW_API  = 'https://api.bilibili.com/x/report/click/now';

  var offset   = 0;        // 服务器时间 - 本地时间
  var armed    = false;    // 是否已挂机等待到点自动开抢
  var running  = false;    // 是否正在抢
  var attempts = 0;        // 已点击次数
  var beginAt  = 0;        // 本轮开始时间
  var startMs  = 0;        // 开抢时刻（服务器时间轴）
  var timer    = 0;
  var delay    = 0;        // 下一次轮询的间隔（失败后退避）
  var fails    = 0;        // 连续查询失败次数
  var capStreak = 0;       // 「每日库存已达上限」连续命中次数
  var lastDone = false;    // 上一次查到的「已完成任务」，盲点前必须为 true
  var title0   = document.title;

  function jitter(ms) { return Math.round(ms * (1 - JITTER + Math.random() * JITTER * 2)); }
  function inGrab() {                                         // 卡点窗口内不看库存：库存只用来决定「要不要收工」
    return startMs > 0 && srv() >= startMs && srv() - startMs <= GRAB_MIN * 60000;
  }
  function nearReset() {                                      // 距次日 0 点（服务器时间）是否在 RESET_GRACE_MIN 分钟内
    var d = new Date(srv());
    d.setHours(24, 0, 0, 0);
    return d.getTime() - srv() <= RESET_GRACE_MIN * 60000;
  }

  function srv() { return Date.now() + offset; }              // 当前服务器时间轴（毫秒）
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(ms) {                                        // 服务器时间轴的时钟串
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function dur(ms) {                                          // 倒计时串
    var s = Math.max(0, Math.ceil(ms / 1000));
    return (s >= 3600 ? pad(Math.floor(s / 3600)) + ':' : '') + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
  }
  function beep(ok) {
    try {
      var C = window.AudioContext || window.webkitAudioContext, a = new C(), o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(a.destination); o.frequency.value = ok ? 880 : 320; g.gain.value = 0.15;
      a.resume && a.resume(); o.start(); setTimeout(function () { o.stop(); a.close(); }, ok ? 500 : 900);
    } catch (e) {}
  }

  /* ---------------- 面板 ---------------- */
  var css = document.createElement('style');
  css.textContent =
    '#bae{position:fixed;right:12px;top:12px;z-index:2147483647;width:228px;padding:10px 12px;border-radius:10px;' +
    'background:rgba(24,24,30,.93);color:#e8e8ea;font:12px/1.7 -apple-system,"Microsoft YaHei",sans-serif;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.45);user-select:none}' +
    '#bae h3{margin:0 0 6px;font-size:13px;color:#fb7299;display:flex;justify-content:space-between;align-items:center}' +
    '#bae h3 i{font-style:normal;cursor:pointer;color:#888;padding:0 4px}' +
    '#bae p{margin:2px 0}' +
    '#bae input{width:62px;background:#2c2c34;border:1px solid #4a4a52;color:#e8e8ea;border-radius:4px;' +
    'padding:1px 4px;font:inherit;text-align:center}' +
    '#bae button{background:#fb7299;border:0;color:#fff;border-radius:4px;padding:2px 9px;font:inherit;' +
    'cursor:pointer;margin-left:4px}' +
    '#bae button.stop{background:#5a5a62}' +
    '#bae .big{font-size:14px;color:#ffd75e;font-weight:600}' +
    '#bae .dim{color:#9a9aa2}' +
    '#bae .warn{color:#ff7b7b}' +
    '#bae.min .body{display:none}';
  document.head.appendChild(css);

  var box = document.createElement('div');
  box.id = 'bae';
  box.innerHTML =
    '<h3><span>B站奖励自动领取</span><i id="bae-min">—</i></h3>' +
    '<div class="body">' +
      '<p>开抢时刻 <input id="bae-time" value="' + (localStorage.getItem(TIME_KEY) || '23:59:00') + '">' +
      '<button id="bae-btn">开始</button></p>' +
      '<p class="big" id="bae-cd">正在对时…</p>' +
      '<p id="bae-st">读取任务状态…</p>' +
      '<p class="dim" id="bae-stock"></p>' +
      '<p class="dim" id="bae-log">待机</p>' +
    '</div>';
  document.body.appendChild(box);

  function $(id) { return document.getElementById(id); }
  function setText(id, m) { var e = $(id); if (e.textContent !== m) e.textContent = m; }  // 值没变就不碰 DOM
  function log(m) { setText('bae-log', m); }
  function big(m, warn) {
    var e = $('bae-cd'), c = 'big' + (warn ? ' warn' : '');
    if (e.textContent !== m) e.textContent = m;
    if (e.className !== c) e.className = c;
  }

  /* ---------------- 时间与调度 ---------------- */
  function syncTime() {
    return fetch(NOW_API, { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.code === 0) offset = j.data.now * 1000 - Date.now(); })
      .catch(function () {});
  }

  function parseTime(v) {                                     // '23:59:00' -> 今天的该时刻（服务器时间轴）
    var m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec((v || '').trim());
    if (!m) return 0;
    var d = new Date(srv());
    d.setHours(+m[1], +m[2], +(m[3] || 0), 0);
    return d.getTime();
  }

  function arm() {                                            // 按输入时刻挂机，已过点则立即开始
    var t = parseTime($('bae-time').value);
    if (!t) { big('时刻格式不对，用 HH:MM:SS', true); return; }
    localStorage.setItem(TIME_KEY, $('bae-time').value.trim());
    var now = srv();
    // 刚过 0 点打开（距「昨晚那个时刻」不到 POST_MIN 分钟）：新一天的库存刚放出来，立刻抢，别傻等今晚 23:59
    var justAfter = now < t && now - (t - 864e5) <= POST_MIN * 60000;
    startMs = justAfter ? now : t;
    armed = true;
    log(justAfter ? '刚过 0 点（' + POST_MIN + ' 分钟内），立即开抢' : '已挂机，到点自动开抢');
    if (srv() >= startMs) go();
  }

  function syncBtn() {
    var b = $('bae-btn');
    b.textContent = (running || armed) ? '停止' : '开始';
    b.className = (running || armed) ? 'stop' : '';
  }

  /* ---------------- 抢领主循环 ---------------- */
  function getInfo() {
    return fetch(INFO_API, { credentials: 'include' }).then(function (r) { return r.json(); });
  }

  function finish(msg, ok) {
    running = false; armed = false; clearTimeout(timer);
    big(msg, !ok);
    document.title = (ok ? '✅ ' : '⚠ ') + title0;
    beep(!!ok);
    syncBtn();
  }

  function clickReceive() {
    var btn = document.querySelector('.exchange-button');
    if (!btn) { log('未找到领取按钮，稍后重试'); return 0; }
    if (btn.classList.contains('no-login')) { finish('页面未登录，请先登录后重开', false); return 0; }
    btn.click();
    attempts++;
    log('第 ' + attempts + ' 次点击领取 · ' + clock(srv()));
    return 1;
  }

  function backoff(msg) {                                      // 失败退避：间隔翻倍，上限 BACKOFF_MAX
    fails++;
    delay = Math.min(BACKOFF_MAX, delay * 2 || POLL_MS * 2);
    setText('bae-st', '查询失败 ' + msg);
    log('连续失败 ' + fails + ' 次，退避 ' + Math.round(delay / 1000) + 's 后重试');
  }

  function tick() {
    if (!running) return;
    var wait = POLL_MS, t0 = Date.now();
    // 卡点窗口内盲点：不等 info 返回「可领取」再点，第一步就先点下去。
    // 页面自身的 handleReceiveClick 有 1 秒节流，所以这就是手动连点能达到的上限，点多了也发不出去
    var blind = BLIND && lastDone && inGrab() && srv() - startMs <= BLIND_MIN * 60000;
    if (blind && clickReceive()) wait = CLICK_MS;
    getInfo().then(function (j) {
      var d = j && j.data;
      if (!d) {                                  // code 非 0：多半是风控（-351/-352）或限流（-702/-509）
        backoff((j && j.code) + ' ' + ((j && j.message) || '网络异常'));
        return;
      }
      fails = 0; delay = 0;                      // 一次成功即恢复正常节奏
      var st = d.status, s = d.stock_info || {};
      var done = d.task_finished === true;                    // 页面上的「已完成任务」
      lastDone = done;
      // 只信页面自己显示的两个百分比字段：实测 total_stock=80(%) 与 total_remain_num=0 同时出现，
      // 那两个 *_remain_num 计数在非资格/未登录账号上恒为 0，拿它当判据会误判「已领完」
      var dayPct = Number(s.day_stock), totalPct = Number(s.total_stock);
      var capped = (s.day_stock_limit && dayPct === 0)
        || (s.total_stock_limit && totalPct === 0)
        || /库存已达上限|每日库存/.test(d.message || '');
      setText('bae-st', (st === 6 ? '已领取' : (d.message || '未知')) +
        '（status ' + st + '，' + (done ? '已完成任务' : '任务未完成') + '）');
      setText('bae-stock', s.day_stock_limit ? '当日剩余 ' + s.day_stock + '%'
        : (s.total_stock_limit ? '总剩余 ' + s.total_stock + '%' : ''));

      if (st === 6) return finish('领取成功', true);
      if (st === 1) return finish('需先绑定直播账号，请手动处理后重开', false);
      if (!done) { log('任务未完成，不抢（' + (d.task_desc || '未达标') + '）'); return; }
      if (st === 0) { capStreak = 0; if (!blind && clickReceive()) wait = CLICK_MS; }   // 盲点模式下这 tick 已经点过了
      else if (capped && !inGrab() && !nearReset()) {         // 卡点窗口内无视库存；且要连续 CAP_CONFIRM 次才收工
        capStreak++;
        if (capStreak >= CAP_CONFIRM) {
          return finish('每日库存已达上限（连续 ' + capStreak + ' 次确认），今天没戏了', false);
        }
        log('疑似每日库存已达上限，复核 ' + capStreak + '/' + CAP_CONFIRM);
      } else {
        capStreak = 0;
        log(inGrab() ? '卡点窗口内：无视库存，只等可领取（status ' + st + '）'
          : (capped ? '每日库存已达上限，等 0 点刷新'
            : (dayPct > 0 ? '有货（当日 ' + dayPct + '%）但不可领：' + (d.message || '') + '（status ' + st + '）'
              : '等待放量：' + (d.message || '暂不可领取') + '（status ' + st + '）')));
      }
    }).catch(function (e) { backoff((e && e.message) || e); }).then(function () {
      if (!running) return;
      if (fails >= MAX_FAILS) return finish('连续 ' + fails + ' 次被风控拦截，已停止', false);
      if (attempts >= MAX_ATTEMPTS) return finish('点击 ' + attempts + ' 次仍未成功，已停止', false);
      if (Date.now() - beginAt > MAX_MINUTES * 60000) return finish('超过 ' + MAX_MINUTES + " 分钟仍未成功，已停止", false);
      var next = (!delay && wait === CLICK_MS)
        ? Math.max(0, CLICK_MS - (Date.now() - t0)) + ((Math.random() * 40) | 0)   // 扣掉本轮 info 往返，让「点击→点击」正好贴住 1 秒
        : jitter(delay || wait);
      timer = setTimeout(tick, next);
    });
  }

  function go() {
    if (running) return;
    armed = false; running = true; attempts = 0; beginAt = Date.now(); fails = 0; delay = 0; capStreak = 0;
    lastDone = false;
    big('抢领中…'); log('开始抢领');
    syncBtn();
    tick();
  }

  function stop() {
    running = false; armed = false; clearTimeout(timer);
    big('已停止'); log('已手动停止');
    syncBtn();
  }

  /* ---------------- 页面提示捕获（成功提示 / 风控验证码） ---------------- */
  // 观察范围是整个 body，回调必须足够廉价：只挑「刚插进来、而且很小」的元素节点读一次文本。
  // 旧写法对每个新节点都读 textContent，页面一有动画/列表刷新就把主线程读死（标签页卡死）；
  // 而且自己写面板产生的节点也在观察范围内，可能自己触发自己。
  var RISK = /拖动|滑块|验证码|安全验证|完成验证|行为验证/;
  var scanQ = [], scanTimer = 0;
  function scanNode(n) {
    if (n.nodeType !== 1) return;                                      // 文本节点不处理（自己写面板产生的就是这个）
    if (n.id === 'bae' || (n.closest && n.closest('#bae'))) return;    // 自家面板不看
    if (n.childElementCount > 8) return;                               // 大子树不读文本：提示/弹窗都很小
    var txt = (n.textContent || '').trim();
    if (!txt) return;
    var tag = (n.id || '') + ' ' + (n.className || '');
    if (txt.length < 40 && (RISK.test(txt) || /captcha|gaia/i.test(tag))) {
      if (running) finish('触发风控验证码，请完成验证后重开', false);
    } else if (txt.length < 60 && /领取成功/.test(txt)) {
      log('页面提示：领取成功');
    }
  }
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length && scanQ.length < 200; i++) {
      var a = muts[i].addedNodes;
      for (var j = 0; j < a.length && scanQ.length < 200; j++) scanQ.push(a[j]);
    }
    if (scanTimer || !scanQ.length) return;
    scanTimer = setTimeout(function () {                               // 攒一批再扫，最多 3 次/秒，和页面渲染解耦
      scanTimer = 0;
      var q = scanQ; scanQ = [];
      for (var k = 0; k < q.length; k++) { try { scanNode(q[k]); } catch (err) {} }
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  /* ---------------- 交互与启动 ---------------- */
  $('bae-btn').addEventListener('click', function () { (running || armed) ? stop() : go(); });
  $('bae-time').addEventListener('change', function () { if (!running) { armed = false; big('已改时刻，点开始挂机'); syncBtn(); } });
  $('bae-min').addEventListener('click', function () { box.classList.toggle('min'); });

  setInterval(function () {                                   // 倒计时刷新 + 到点自动开抢
    if (running) return;
    if (armed) {
      var left = startMs - srv();
      big('倒计时 ' + dur(left));
      if (left <= 0) go();
    } else if (!running && $('bae-cd').textContent === '正在对时…') {
      big('点「开始」挂机抢领');
    }
  }, 250);

  syncTime().then(function () {
    big('点「开始」挂机抢领');
    arm();                                                    // 默认 23:59:00 自动挂机
  });
})();
