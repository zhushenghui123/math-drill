/* web/js/layout.js —— 界面模式（自动 / 手机 / 电脑），并给 <html> 打上 data-layout
 *
 * 为什么要有这个开关（决策人 2026-09-17 要求）：
 *   手机适配**绝不能影响电脑端**。做法不是"尽量不影响"，而是结构上隔离：
 *   所有手机样式都写在 `html[data-layout="mobile"]` 选择器下面（见 assets/mobile.css），
 *   电脑模式下那批规则一次都不会命中。
 *
 * 默认 = 自动：视口 ≤ 430px 视为手机（小米15 ≈ 400×890、iPhone15 ≈ 393×852 都在这一档），
 * 否则电脑。手动切换会记住（localStorage），优先级高于自动；再点回"自动"即恢复。
 *
 * no-JS 兜底：脚本没跑时 <html> 上没有 data-layout → mobile.css 全部不生效 → 与改动前完全一致。
 */
(function (root) {
  'use strict';

  var KEY = 'md_layout';                 // 'auto' | 'mobile' | 'desktop'
  var PHONE_MAX = 430;                   // CSS 像素；小米15=400、iPhone15=393、SE=375 都在内
  var doc = root.document;
  var mode = 'auto';

  function readStored() {
    try {
      var v = root.localStorage && root.localStorage.getItem(KEY);
      return (v === 'mobile' || v === 'desktop') ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  function isPhoneViewport() {
    if (root.matchMedia) return root.matchMedia('(max-width: ' + PHONE_MAX + 'px)').matches;
    return (root.innerWidth || 1024) <= PHONE_MAX;
  }

  function resolve(m) {
    if (m === 'mobile' || m === 'desktop') return m;
    return isPhoneViewport() ? 'mobile' : 'desktop';
  }

  function apply() {
    if (!doc || !doc.documentElement) return resolve(mode);
    var eff = resolve(mode);
    doc.documentElement.setAttribute('data-layout', eff);
    return eff;
  }

  function persist(m) {
    try { if (root.localStorage) root.localStorage.setItem(KEY, m); } catch (e) { /* 忽略 */ }
  }

  var MDLayout = {
    PHONE_MAX: PHONE_MAX,
    get: function () { return mode; },            // 用户选的模式（含 'auto'）
    effective: apply,                              // 实际生效的（'mobile' | 'desktop'）
    set: function (m) {                            // 'auto' | 'mobile' | 'desktop'
      if (m !== 'auto' && m !== 'mobile' && m !== 'desktop') return MDLayout.effective();
      mode = m;
      persist(m);
      return apply();
    },
    cycle: function () {                           // 自动 → 手机 → 电脑 → 自动
      return MDLayout.set(mode === 'auto' ? 'mobile' : mode === 'mobile' ? 'desktop' : 'auto');
    },
    label: function (m) {
      m = m || mode;
      return m === 'mobile' ? '手机版' : m === 'desktop' ? '电脑版' : '自动';
    }
  };

  mode = readStored();
  apply();                                        // 尽早打上，避免首屏闪一下

  // 视口变化时（仅自动模式）跟着切
  try {
    if (root.matchMedia) {
      var mq = root.matchMedia('(max-width: ' + PHONE_MAX + 'px)');
      var onChange = function () { if (mode === 'auto') apply(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (e) { /* 老浏览器忽略 */ }

  // 界面上的切换按钮（index.html 里的 #layout-toggle）
  function wireButton() {
    if (!doc) return;
    var btn = doc.getElementById('layout-toggle');
    if (!btn) return;
    var render = function () {
      btn.textContent = '界面：' + MDLayout.label();
      btn.title = '点击切换：自动 → 手机版 → 电脑版（当前视口 ' + (root.innerWidth || '?') + 'px）';
    };
    btn.addEventListener('click', function () { MDLayout.cycle(); render(); });
    render();
  }
  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wireButton);
    else wireButton();
  }

  root.MDLayout = MDLayout;
})(typeof window !== 'undefined' ? window : this);
