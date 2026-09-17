/* 研数 · 模型通道层（零依赖）
 *
 * 统一走 OpenAI 兼容协议，覆盖两类后端：
 *   1) 本地服务：LM Studio / Ollama / vLLM / llama.cpp —— 免 Key、离线、数据不出本机
 *   2) 云端服务：DeepSeek / Kimi / 通义 等 —— 填 Base URL + Key 即可
 *
 * 对外能力：
 *   LLM.detectLocal()    自动探测本机在跑的推理服务
 *   LLM.probe(base, key) 结构化探测：分清「连不上 / Key 不对 / 路径不对」
 *   LLM.listModels(base) 拉取模型列表（不带 Key，供本机探测）
 *   LLM.chat(conf, msgs, opts)  对话；支持流式增量回调与工具调用
 *   LLM.testConnection(conf)    设置页"测试连接"（会带上 Key）
 *
 * 工具调用做了双通道：优先用 OpenAI 原生 tool_calls；若模型（常见于本地小模型）
 * 只在正文里吐 JSON，则用 ```tool 代码块协议兜底解析。
 */
window.LLM = (function () {
  'use strict';

  var LOCAL_CANDIDATES = [
    { name: 'LM Studio', base: 'http://127.0.0.1:1234/v1' },
    { name: 'Ollama', base: 'http://127.0.0.1:11434/v1' },
    { name: 'vLLM', base: 'http://127.0.0.1:8000/v1' },
    { name: 'llama.cpp', base: 'http://127.0.0.1:8081/v1' }
  ];

  function trimBase(b) { return String(b || '').trim().replace(/\/+$/, ''); }

  function isFileProtocol() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  /* 判断是不是本机推理服务（决定报错时该给哪套建议） */
  function isLocalBase(base) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(String(base || ''));
  }

  /* 连接失败时给出可操作的提示，而不是干巴巴的 Failed to fetch。
     reason 来自 probe()：auth / http / notjson / timeout / network */
  function connHint(base, reason) {
    var local = isLocalBase(base);

    if (reason === 'auth') {
      return local
        ? '本机服务返回了「未授权」。本地推理服务通常不需要 Key，请把 API Key 清空后再试。'
        : 'Key 被拒绝（401/403）。请检查：是否复制完整（含 sk- 前缀、无多余空格）、是否已过期、账户是否欠费。';
    }
    if (reason === 'notjson') {
      return '请确认「接口地址」填的是 API 根地址（例如 https://api.deepseek.com），不要带 /chat/completions 这类路径。';
    }
    if (reason === 'timeout') {
      return '请求超时。' + (local
        ? '本机服务可能没启动，或模型正在加载中。'
        : '请检查网络与代理设置。');
    }

    /* 网络层失败：跨域被拦 / DNS / 代理 / 服务没开，浏览器一律报 Failed to fetch，只能按通道给建议 */
    if (local) {
      if (isFileProtocol()) {
        return '当前页面是 file:// 打开的，浏览器会拦截对 ' + base + ' 的请求（跨域限制）。' +
          '请在项目目录执行 `python3 -m http.server 8080`，然后用 http://localhost:8080 打开本页。';
      }
      return '请确认本地推理服务已启动，且允许来自本页面的跨域请求（LM Studio 需在 Server 设置里开启 CORS）。';
    }
    return '浏览器没能建立到 ' + base + ' 的连接。请检查网络能否访问该地址（代理、公司网络或防火墙可能拦截），以及「接口地址」是否填错。';
  }

  function withTimeout(ms) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return {
      signal: ctl ? ctl.signal : undefined,
      done: function () { clearTimeout(timer); }
    };
  }

  /* ---------------- 探测与模型列表 ---------------- */

  /* 探测一个 base 是否是可用后端。返回结构化结果而不是 null，
     这样调用方才能分清「连不上」和「Key 不对」——这两件事的处理方式完全不同。
     key 可选：本地服务不传，云端必须传。 */
  async function probe(base, key, timeoutMs) {
    var b = trimBase(base);
    if (!b) return { ok: false, reason: 'http', status: 0, base: b };

    // 有的网关只认 /v1/models，有的两种都认。先试原样，404 再补 /v1。
    var urls = [b + '/models'];
    if (!/\/v1$/i.test(b)) urls.push(b + '/v1/models');

    var last = null;
    for (var i = 0; i < urls.length; i++) {
      var r = await probeOne(urls[i], key, timeoutMs);
      if (r.ok) { r.base = b; return r; }
      last = r;
      // 只有「路径不存在」才值得换 URL 重试；认证失败/网络不通换路径也没用
      if (r.reason !== 'http' || (r.status !== 404 && r.status !== 405)) break;
    }
    last.base = b;
    return last;
  }

  async function probeOne(url, key, timeoutMs) {
    var tm = withTimeout(timeoutMs || 6000);
    var headers = {};
    if (key) headers['Authorization'] = 'Bearer ' + key;
    try {
      var res = await fetch(url, { headers: headers, signal: tm.signal });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status };
      if (!res.ok) return { ok: false, reason: 'http', status: res.status };
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) return { ok: false, reason: 'notjson', status: res.status };
      var j = await res.json();
      var raw = j.data || j.models || [];
      var ids = raw.map(function (m) { return m.id || m.name; }).filter(Boolean);
      return { ok: true, ids: ids, status: res.status };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'network', detail: String((e && e.message) || e) };
    } finally {
      tm.done();
    }
  }

  /* 只问「这个地址有没有活的推理服务」，失败或空列表一律 null —— 供本机探测使用 */
  async function listModels(base, timeoutMs) {
    var r = await probe(base, '', timeoutMs);
    if (!r.ok || !r.ids || !r.ids.length) return null;
    return r.ids;
  }

  async function detectLocal(onProgress) {
    for (var i = 0; i < LOCAL_CANDIDATES.length; i++) {
      var c = LOCAL_CANDIDATES[i];
      if (onProgress) onProgress('探测 ' + c.name + ' (' + c.base + ') …');
      var ids = await listModels(c.base, 2500);
      if (ids) {
        return { name: c.name, base: c.base, models: ids };
      }
    }
    return null;
  }

  /* ---------------- 工具调用文本兜底 ---------------- */

  var TOOL_BLOCK_RE = /```(?:tool|tool_call|json)\s*\n?([\s\S]*?)```/g;

  function parseTextToolCalls(text) {
    var out = [], m;
    if (!text) return out;
    TOOL_BLOCK_RE.lastIndex = 0;
    while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
      var body = m[1].trim();
      if (!body) continue;
      var j = null;
      try { j = JSON.parse(body); } catch (e) { continue; }
      // 允许 {name, arguments} 或 {tool, args} 或 {name, parameters}
      var name = j.name || j.tool || j.function || j.tool_name;
      if (!name || typeof name !== 'string') continue;
      out.push({
        id: 'text_' + out.length + '_' + Date.now().toString(36),
        name: name,
        args: j.arguments || j.args || j.parameters || j.input || {},
        fromText: true
      });
    }
    return out;
  }

  /* 把正文里的工具块剥掉，只留给人看的部分 */
  function stripToolBlocks(text) {
    if (!text) return '';
    return text.replace(TOOL_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function safeParseArgs(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    var s = String(raw).trim();
    if (!s) return {};
    try { return JSON.parse(s); } catch (e) { return { __raw: s }; }
  }

  /* ---------------- 对话 ---------------- */

  async function chat(conf, messages, opts) {
    opts = opts || {};
    var base = trimBase(conf.base);
    if (!base) throw new Error('未配置模型地址');
    if (!conf.model) throw new Error('未选择模型');

    var useStream = opts.stream !== false;
    var body = {
      model: conf.model,
      messages: messages,
      stream: useStream,
      temperature: opts.temperature != null ? opts.temperature : 0.4
    };
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    var headers = { 'Content-Type': 'application/json' };
    if (conf.key) headers['Authorization'] = 'Bearer ' + conf.key;

    var res;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('请求已取消');
      throw new Error('无法连接模型服务 ' + base + '。' + connHint(base));
    }

    if (!res.ok) {
      var errText = '';
      try { errText = await res.text(); } catch (e2) { /* ignore */ }
      throw new Error('模型返回 ' + res.status + '：' + String(errText).slice(0, 200));
    }

    if (!useStream) {
      var j = await res.json();
      var msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      var tc = (msg.tool_calls || []).map(function (c, i) {
        return { id: c.id || ('call_' + i), name: c.function && c.function.name, args: safeParseArgs(c.function && c.function.arguments) };
      }).filter(function (c) { return c.name; });
      var text = msg.content || '';
      if (!tc.length) tc = parseTextToolCalls(text).map(function (c) { return { id: c.id, name: c.name, args: safeParseArgs(c.args), fromText: true }; });
      if (tc.length) text = stripToolBlocks(text);
      if (opts.onDelta && text) opts.onDelta(text, text);
      return { content: text, toolCalls: tc, raw: j };
    }

    if (!res.body) throw new Error('当前浏览器不支持流式响应');

    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', content = '', calls = [], finished = false;

    while (!finished) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });

      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') { finished = true; break; }

        var evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }
        var choice = (evt.choices && evt.choices[0]) || {};
        var delta = choice.delta || {};

        if (delta.content) {
          content += delta.content;
          if (opts.onDelta) opts.onDelta(delta.content, content);
        }
        if (delta.tool_calls) {
          delta.tool_calls.forEach(function (part) {
            var i = part.index != null ? part.index : calls.length;
            if (!calls[i]) calls[i] = { id: '', name: '', rawArgs: '' };
            if (part.id) calls[i].id = part.id;
            if (part.function) {
              if (part.function.name) calls[i].name = part.function.name;
              if (part.function.arguments) calls[i].rawArgs += part.function.arguments;
            }
          });
        }
      }
    }
    try { reader.cancel(); } catch (e) { /* ignore */ }

    var toolCalls = calls.filter(function (c) { return c && c.name; }).map(function (c) {
      return { id: c.id || ('call_' + c.name), name: c.name, args: safeParseArgs(c.rawArgs) };
    });

    // 原生没给工具调用 → 尝试从正文里捞
    if (!toolCalls.length) {
      var textCalls = parseTextToolCalls(content);
      if (textCalls.length) {
        toolCalls = textCalls.map(function (c) { return { id: c.id, name: c.name, args: safeParseArgs(c.args), fromText: true }; });
        content = stripToolBlocks(content);
        if (opts.onDelta) opts.onDelta('', content);
      }
    }

    return { content: content, toolCalls: toolCalls };
  }

  /* 有些兼容网关压根不实现 /models。可我们要回答的问题是「能不能对话」，
     那就直接发一次最小请求（1 token）来验，别拿一个可选的探测接口当准绳。 */
  async function probeChat(conf, timeoutMs) {
    var tm = withTimeout(timeoutMs || 8000);
    var headers = { 'Content-Type': 'application/json' };
    if (conf.key) headers['Authorization'] = 'Bearer ' + conf.key;
    try {
      var res = await fetch(trimBase(conf.base) + '/chat/completions', {
        method: 'POST',
        headers: headers,
        signal: tm.signal,
        body: JSON.stringify({
          model: conf.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false
        })
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status };
      if (res.ok) return { ok: true, ids: [], viaChat: true };
      var t = '';
      try { t = await res.text(); } catch (e) { /* ignore */ }
      // 400 且报的是模型名问题 —— 连接其实是通的，只是模型选错了
      if (res.status === 400 && /model/i.test(t)) {
        return { ok: true, ids: [], viaChat: true, warn: '接口能连上，但模型名可能不对：' + String(t).slice(0, 140) };
      }
      return { ok: false, reason: 'http', status: res.status, detail: String(t).slice(0, 160) };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'network', detail: String((e && e.message) || e) };
    } finally {
      tm.done();
    }
  }

  /* 前缀要说清「到底连上没有」——「连不上」和「连上了但 Key 不对」
     是两件完全不同的事，混成一句用户就无从下手。 */
  function failMessage(base, r) {
    var b = trimBase(base);
    var prefix;
    if (r.reason === 'network') prefix = '连不上 ' + b + '。';
    else if (r.reason === 'timeout') prefix = '连接 ' + b + ' 超时。';
    else if (r.reason === 'auth') prefix = b + ' 已连通，但鉴权没过。';
    else if (r.reason === 'notjson') prefix = b + ' 有响应，但返回的不是 OpenAI 兼容接口。';
    else prefix = b + ' 返回 HTTP ' + (r.status || '?') + '。';
    return prefix + connHint(base, r.reason);
  }

  /* 设置页「测试连接」。
     注意：必须把 Key 一起带上——云端 /models 是要鉴权的，
     不带 Key 会稳定拿到 401，从而把「Key 填对了」也误报成「连不上」。 */
  async function testConnection(conf) {
    var r = await probe(conf.base, conf.key, 8000);

    // 该地址没有 /models（404/405）不代表不能用，改用真实对话来判定
    if (!r.ok && r.reason === 'http' && (r.status === 404 || r.status === 405)) {
      r = await probeChat(conf, 8000);
    }
    if (!r.ok) {
      var err = new Error(failMessage(conf.base, r));
      err.reason = r.reason;
      err.status = r.status;
      throw err;
    }

    // 连上了，但填的模型名不在服务端列表里 —— 不算失败，但要说清楚
    var warn = r.warn || '';
    if (!warn && conf.model && r.ids && r.ids.length && r.ids.indexOf(conf.model) < 0) {
      warn = '接口能连上，但服务端模型列表里没有「' + conf.model + '」。可用：' + r.ids.slice(0, 6).join('、');
    }
    return { ids: r.ids || [], viaChat: !!r.viaChat, warn: warn };
  }

  return {
    LOCAL_CANDIDATES: LOCAL_CANDIDATES,
    detectLocal: detectLocal,
    listModels: listModels,
    probe: probe,
    chat: chat,
    testConnection: testConnection,
    parseTextToolCalls: parseTextToolCalls,
    stripToolBlocks: stripToolBlocks,
    isFileProtocol: isFileProtocol,
    isLocalBase: isLocalBase,
    connHint: connHint
  };
})();
