/* web/js/api.js —— **唯一的存储交互桥 + judge 客户端**（ADR-002 / BOUNDARY §1）
 *
 * 纪律（改它就等于改了全站数据流，动手前先看 docs/BOUNDARY.md §1）：
 *   ① 本文件是**唯一**允许发起 HTTP 的地方；其它 js 不许直接 fetch/XHR
 *   ② localStorage 只作**本地缓存**（离线可用），服务端 blob 才是同步真相源
 *   ③ 判定一律 POST /api/judge —— 前端不再有任何比对逻辑（JUDGE_CONTRACT I1）
 *   ④ 不得新增第二个端口 / 第二个网关（ARCHITECTURE §11.5）
 *
 * 题库窗口（ADR-017，已落地）：`/m/qbank/*` 的薄封装在文件末尾：
 *   qbankList({subject, kid, done, limit}) → GET /m/qbank/list
 *   qbankDetail(qid)                       → GET /m/qbank/detail
 * ⚠️ 这两条**不是新端点**：它们是模块路由 `/m/<模块>/<rpc>`（端点集合仍是五个）；
 *    服务端**不回 answer/analysis**，所以这里也没有"要答案"的方法。
 */
(function (root) {
  'use strict';

  var DB_KEY = 'kaoyan_math_tutor_v1';   // 沿用旧存档键名：改了就等于丢掉用户旧进度
  var DEBOUNCE_MS = 800;

  var state = {
    version: 0,        // 与服务端 server_version 对齐
    pending: false,    // 有本地改动还没推上去
    online: true,      // 最近一次请求是否成功
    lastError: null,
    lastSync: 0
  };
  var listeners = [];
  var timer = null;

  function status() {
    return {
      version: state.version, pending: state.pending, online: state.online,
      lastError: state.lastError, lastSync: state.lastSync
    };
  }

  function notify() {
    var s = status();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](s); } catch (e) { /* 监听者自己出错不该影响同步 */ }
    }
  }

  function device() {
    var ua = (root.navigator && root.navigator.userAgent) || '';
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    if (/Mobile|Android|iPhone/i.test(ua)) return 'phone';
    return 'desktop';
  }

  function readCache() {
    try {
      var raw = root.localStorage ? root.localStorage.getItem(DB_KEY) : null;
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeCache(data) {
    try {
      if (root.localStorage) root.localStorage.setItem(DB_KEY, JSON.stringify(data));
    } catch (e) { /* 存储满等异常忽略：下次同步仍能把服务端版本带回来 */ }
  }

  function request(method, url, body) {
    if (typeof root.fetch !== 'function') {
      return Promise.reject(new Error('当前环境不支持 fetch（file:// 直接打开时属正常，需经服务端访问）'));
    }
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return root.fetch(url, opt).then(function (r) {
      state.online = true;
      return r.text().then(function (txt) {
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { _raw: txt }; }
        return { status: r.status, data: data };
      });
    }, function (err) {
      state.online = false;
      state.lastError = String((err && err.message) || err);
      notify();
      throw err;
    });
  }

  function push(data) {
    state.pending = true;
    notify();
    return request('PUT', '/api/state', { base_version: state.version, data: data })
      .then(function (r) {
        if (r.status === 200 && r.data && typeof r.data.server_version === 'number') {
          state.version = r.data.server_version;
          state.pending = false;
          state.lastSync = Date.now();
          notify();
          return r.data;
        }
        if (r.status === 409) {
          // 版本冲突（§3.5）：采用服务端版本号后重放一次，服务端按 newer-wins 合并
          var latest = (r.data && r.data.latest) || {};
          if (typeof latest.server_version === 'number') state.version = latest.server_version;
          notify();
          return request('PUT', '/api/state', { base_version: state.version, data: data })
            .then(function (r2) {
              if (r2.status === 200) {
                state.version = r2.data.server_version;
                state.pending = false;
                state.lastSync = Date.now();
              }
              notify();
              return r2.data;
            });
        }
        if (r.status === 401) {
          state.online = false;
          state.lastError = '未登录（缺会话 cookie）——先访问 /setup?t=<token>';
        }
        notify();
        return r.data;
      });
  }

  var MDStore = {
    DB_KEY: DB_KEY,

    /* 同步读缓存：app.js 的 load() 启动时同步调用（离线也要能打开） */
    loadCached: readCache,

    /* 同步入口：45 个 save() 调用点走这里（签名不变），内部去抖推送 */
    save: function (data) {
      writeCache(data);
      state.pending = true;
      notify();
      if (timer) root.clearTimeout(timer);
      timer = root.setTimeout(function () { timer = null; push(data); }, DEBOUNCE_MS);
    },

    /* 清档（对应原来第三处 localStorage.removeItem） */
    clear: function () {
      try { if (root.localStorage) root.localStorage.removeItem(DB_KEY); } catch (e) { /* 忽略 */ }
      state.version = 0;
      state.pending = false;
      notify();
    },

    /* 启动时与服务端对账：服务端有数据 → 它就是真相源（覆盖本地缓存） */
    bootstrap: function () {
      return request('GET', '/api/state').then(function (r) {
        if (r.status !== 200 || !r.data || typeof r.data.server_version !== 'number') {
          if (r.status === 401) {
            state.online = false;
            state.lastError = '未登录（缺会话 cookie）——先访问 /setup?t=<token>';
            notify();
          }
          return { source: 'cache', data: readCache() };
        }
        state.version = r.data.server_version;
        var serverData = r.data.data || {};
        if (Object.keys(serverData).length > 0) {
          writeCache(serverData);
          state.pending = false;
          state.lastSync = Date.now();
          notify();
          return { source: 'server', data: serverData };
        }
        var local = readCache();
        if (local) push(local);      // 服务端还空、本地有 → 首次上云
        return { source: 'cache', data: local };
      });
    },

    /* 判定：唯一入口（前端不做任何比对） */
    judge: function (qid, rawAnswer, opts) {
      opts = opts || {};
      var payload = {
        qid: qid,
        raw_answer: String(rawAnswer == null ? '' : rawAnswer),
        device: device()
      };
      if (opts.userMs != null) payload.user_ms = opts.userMs;
      return request('POST', '/api/judge', payload).then(function (r) {
        if (r.status === 200) return r.data;
        var err = new Error((r.data && (r.data.message || r.data.error)) || ('判定失败 HTTP ' + r.status));
        err.code = r.data && r.data.error;
        err.response = r.data;
        throw err;
      });
    },

    /* 题库：一律由服务端提供（BOUNDARY §0：data-questions.js 已替换为服务端载入）。
       离线/未登录时抛出——调用方（app.js）据此提示去 /setup 拿 cookie。 */
    loadQuestions: function () {
      return request('GET', '/api/daily').then(function (r) {
        if (r.status === 200 && r.data && Array.isArray(r.data.questions)) return r.data.questions;
        var err = new Error((r.data && (r.data.message || r.data.error)) ||
                            ('题库拉取失败 HTTP ' + r.status));
        err.code = r.data && r.data.error;
        throw err;
      });
    },

    /* 题库浏览（ADR-017）：栏目页与题目详情页的数据源。
       ⚠️ 服务端**永不回答案与解析**（列白名单在 core/store.py 的 _VIEW_COLS），
          所以这里拿到的东西可以放心直接渲染。 */
    qbankList: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.subject) qs.push('subject=' + encodeURIComponent(opts.subject));
      if (opts.kid) qs.push('kid=' + encodeURIComponent(opts.kid));
      if (opts.done !== undefined && opts.done !== null) qs.push('done=' + (opts.done ? 'true' : 'false'));
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      return moduleGet('/m/qbank/list', qs, '题库载入失败');
    },

    qbankDetail: function (qid) {
      return moduleGet('/m/qbank/detail', ['qid=' + encodeURIComponent(qid)], '题目载入失败');
    },

    /* 同步状态订阅（给 index.html 的状态灯用） */
    onChange: function (fn) { listeners.push(fn); try { fn(status()); } catch (e) { /* 忽略 */ } },
    status: status
  };

  /* 模块路由的 GET（查询串即入参；服务端把 query 合并进 payload）。
     统一在这里把非 200 变成带 code 的 Error —— 调用方的 catch 只认这一种形状。 */
  function moduleGet(path, qs, failMsg) {
    return request('GET', path + (qs && qs.length ? '?' + qs.join('&') : '')).then(function (r) {
      if (r.status === 200 && r.data) return r.data;
      var err = new Error((r.data && (r.data.message || r.data.error)) || (failMsg + ' HTTP ' + r.status));
      err.code = r.data && r.data.error;
      err.status = r.status;
      throw err;
    });
  }

  root.MDStore = MDStore;
})(typeof window !== 'undefined' ? window : this);
