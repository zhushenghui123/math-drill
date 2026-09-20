window.__ModuleLoader__.load({
	id: "@math-drill/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/contract.js
		/**
		* 宿主半边与客户端半边**共用的契约**（相对 import ⇒ 会被 tsdown 内联进浏览器产物）。
		*
		* 为什么要这个文件（2026-09-20 评审的阻塞项 Z1）：
		* 之前 `SUMMARY_PATH` 在宿主 `src/index.js:27` 与客户端 `src/client/index.ts:19` **各写一份**（两处真值），
		* 而"让客户端从宿主半边 import"是**不可执行**的方向 —— 宿主半边 import 了 `@deepseek-ai/dsh-tools` /
		* `schemastery` 等 Node 侧依赖，浏览器产物一旦 value-import 它，就会撞上
		* `build/web-platform.ts` 那道 purity 闸门（表外 `require` = 必然的运行时抛错）。
		*
		* 正解：把契约放进**谁都不依赖**的这小块，两边相对 import —— tsdown 内联，不落 require 表。
		* **本文件不得 import 任何 `@deepseek-ai/*`**（那就是把上面的问题换个地方重演）。
		*
		* @module @math-drill/dsh-plugin/shared/contract
		*/
		/** 宿主半边挂的只读状态路由；客户端半边从这里取数（两处真值到此为止）。 */
		const STATE_PATH = "/math-drill/summary";
		/**
		* 判定一个响应是不是本客户端认识的形状。
		*
		* @param {unknown} payload - 宿主返回的 JSON。
		* @returns {boolean} 是否是已知版本的状态响应。
		*/
		function isStateResponse(payload) {
			if (payload === null || typeof payload !== "object") return false;
			const candidate = payload;
			if (candidate.schemaVersion !== 1) return false;
			return typeof candidate.ok === "boolean";
		}
		//#endregion
		//#region src/client/index.ts
		/** 本插件需要的浏览器服务：槽位（UI）+ locale（文案字典）。 */
		const inject = ["slots", "locale"];
		/** 文案命名空间（与 `slots.register` 的 `locale` 选项同值）。 */
		const NS = "math-drill";
		/**
		* 文案字典 —— **唯一真源**（`src/client/index.ts` 里不再出现任何产品可见字符串字面量）。
		*
		* 依据：`参考-DSH官方文档-20260920/docs/client-AGENTS.md:115`（所有产品可见文案必须进 typed locale 字典）；
		* 官方写法见 `packages/extensions/ui-cordis/src/client/index.ts:41`。
		* zh/en **键集合必须相等**（有测试盯着）。
		*/
		const DICTS = {
			zh: {
				"label": "考研数学",
				"action.refresh": "刷新",
				"state.loading": "读取中…",
				"error.fetch": "取不到考研数学状态",
				"error.unknownShape": "宿主返回了未知版本的状态（插件与宿主版本不匹配？）"
			},
			en: {
				"label": "Math Drill",
				"action.refresh": "Refresh",
				"state.loading": "Loading…",
				"error.fetch": "Cannot reach the math-drill status route",
				"error.unknownShape": "The host returned an unknown status shape (plugin/host version mismatch?)"
			}
		};
		/**
		* 文案取词：优先用槽位渲染器绑进来的 `t`（`locale: NS` 的产物），没有则回退 zh 字典。
		*
		* 回退**不是第二份真值**：它读的就是上面那份 `DICTS`。这样即使某个宿主没给座位，
		* 面板也只会显示中文而不是键名。
		*/
		function translate(props, key) {
			const seat = props?.t;
			if (typeof seat === "function") return seat(key);
			return DICTS.zh[key];
		}
		/** 槽位注册的 id（同一槽位里与官方/其他插件的条目共存靠它区分）。 */
		const SLOT_ID = "math-drill";
		const BOX_STYLE = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			flexWrap: "wrap",
			padding: "4px 10px",
			margin: "0 0 4px",
			borderRadius: "8px",
			border: "0.5px solid var(--dsw-alias-border-l2)",
			fontSize: "12px",
			lineHeight: "1.5",
			opacity: .92
		};
		const LABEL_STYLE = {
			fontWeight: 600,
			whiteSpace: "nowrap"
		};
		const TEXT_STYLE = {
			whiteSpace: "pre-wrap",
			flex: "1 1 240px"
		};
		const BUTTON_STYLE = {
			border: "0.5px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-brand-primary)",
			borderRadius: "6px",
			padding: "1px 8px",
			fontSize: "12px",
			cursor: "pointer",
			opacity: .8
		};
		/**
		* 状态条组件：挂载时拉一次摘要，点「刷新」再拉。
		*
		* 失败**不抛**：把宿主回的可操作消息原样显示（没配凭据就是提示怎么配），
		* 这样面板本身就是"怎么把它配起来"的说明书。
		*/
		function MathDrillDock(props) {
			const [state, setState] = (0, react.useState)({ kind: "loading" });
			const load = (0, react.useCallback)(async () => {
				setState({ kind: "loading" });
				try {
					const payload = await (await fetch(STATE_PATH, { headers: { Accept: "application/json" } })).json();
					if (!isStateResponse(payload)) {
						setState({
							kind: "failed",
							message: translate(props, "error.unknownShape")
						});
						return;
					}
					setState(payload.ok ? {
						kind: "ready",
						text: payload.text
					} : {
						kind: "failed",
						message: payload.error
					});
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					setState({
						kind: "failed",
						message: `${translate(props, "error.fetch")}：${detail}`
					});
				}
			}, [props]);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const body = state.kind === "loading" ? translate(props, "state.loading") : state.kind === "ready" ? state.text : `⚠️ ${state.message}`;
			return (0, react.createElement)("div", {
				style: BOX_STYLE,
				"data-math-drill": "dock"
			}, (0, react.createElement)("span", { style: LABEL_STYLE }, translate(props, "label")), (0, react.createElement)("span", { style: TEXT_STYLE }, body), (0, react.createElement)("button", {
				type: "button",
				style: BUTTON_STYLE,
				onClick: () => {
					load();
				}
			}, translate(props, "action.refresh")));
		}
		/**
		* 挂载客户端半边：往 `conversation.input.dock` 追加一条。
		*
		* @param ctx - DSH 客户端上下文（cordis）。
		*/
		function apply(ctx) {
			const registerDicts = () => ctx.locale.register(NS, DICTS);
			if (typeof ctx.effect === "function") ctx.effect(registerDicts, `${NS}: dictionaries`);
			else registerDicts();
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: SLOT_ID,
				order: 20,
				locale: NS
			}, MathDrillDock));
		}
		/** 测试用导出：字典（键对齐与文案断言都在测试里）。 */
		const dictionaries = DICTS;
		/** 测试用导出：文案命名空间。 */
		const localeNamespace = NS;
		//#endregion
		exports.apply = apply;
		exports.dictionaries = dictionaries;
		exports.inject = inject;
		exports.localeNamespace = localeNamespace;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map