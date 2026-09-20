window.__ModuleLoader__.load({
	id: "@math-drill/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
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
			if (candidate.schemaVersion !== 2) return false;
			return typeof candidate.ok === "boolean";
		}
		//#endregion
		//#region src/client/MathDrillCard.ts
		/**
		* `math_drill_*` 工具的对话内卡片（keyed `tool.call.toolview`）。
		*
		* 为什么必须自己渲染输出：官方源码写明 **keyed 命中会"替换"通用行**
		* （`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:29-36`：
		* "ui-cordis registers a keyed `tool.call.toolview` entry for it, and a keyed hit REPLACES the generic row"）
		* ⇒ 注册了 key 却不画内容，用户就看不到工具结果了。
		*
		* 数据面（本机 0.1.1-rc.1 的契约，逐字核过）：
		* `ToolCallOwnerProps = { callId, toolName, block, cwd?, home?, openFile, inspect? }`
		* （`packages/client/ui-tool/src/client/contract/slots.ts:29-44`）；
		* `block` 是"冻结的运行中调用**或**已落定结果"：`'kind' in block` 判落定，
		* 落定节点带 `content: readonly ContentBlock[]` / `isError` / `error`
		* （`packages/client/runtime/lib/types/client/sessions/conversation.d.ts:165-185`）。
		*
		* @module @math-drill/dsh-plugin/client/card
		*/
		const BODY_STYLE = {
			border: "0.5px solid var(--dsw-alias-border-l2)",
			borderTop: "0",
			borderRadius: "0 0 8px 8px",
			padding: "8px 12px 10px",
			margin: "0 0 6px",
			fontSize: "12px"
		};
		/** 卡片状态：运行中 / 成功 / 出错（官方 `ToolRowState` 的口径，这里只取我们要的三档）。 */
		function cardState(block) {
			if (block === void 0 || block.kind === void 0) return "running";
			return block.isError === true ? "error" : "ok";
		}
		/** 文本内容行：取 `content` 里的 text 块（非 text 块一律忽略）。 */
		function cardLines(block) {
			return (block?.content ?? []).filter((entry) => entry?.type === "text" && typeof entry.text === "string").flatMap((entry) => String(entry.text).split("\n"));
		}
		/**
		* 渲染一张 `math_drill_*` 卡片。
		*
		* @param props - 槽位渲染器组合出来的 props（见文件头的数据面说明）。
		* @returns React 元素。
		*/
		function MathDrillCard(props) {
			const translate = (key, fallback) => typeof props.t === "function" ? props.t(key) : fallback;
			const state = cardState(props.block);
			const body = cardLines(props.block).join("\n");
			const title = props.toolName === "math_drill_today" ? translate("card.today", "考研数学 · 今日题单") : translate("card.progress", "考研数学 · 进度");
			const mark = state === "running" ? "⏳" : state === "error" ? "⚠️" : "✓";
			const fallback = state === "running" ? translate("card.running", "读取中…") : props.block?.error?.code ?? translate("card.empty", "（没有内容）");
			const [open, setOpen] = (0, react.useState)(true);
			const firstLine = body.split("\n").find((line) => line.trim() !== "") ?? fallback;
			return (0, react.createElement)("div", { "data-math-drill": "card" }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
				icon: (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, { active: state === "ok" }, mark),
				title: `${title}${body === "" ? "" : ` · ${firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine}`}`,
				open,
				expandable: true,
				onToggle: () => {
					setOpen((value) => !value);
				},
				expandOnRowClick: true,
				previewChevron: true
			}, (0, react.createElement)("div", { style: BODY_STYLE }, body === "" ? (0, react.createElement)("div", { style: { opacity: .75 } }, fallback) : (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, { text: body }))));
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* 本插件需要的浏览器服务：**只有槽位**（UI 是硬依赖：没槽位就没面板）。
		*
		* 为什么 `locale` **不写成 inject**（2026-09-20 定点复查的清单项）：
		* 硬 `inject` 的语义是"服务不出现就一直等" ⇒ 若某个宿主没有 locale 服务，插件会**静默不激活**
		* （面板整块不见、也不报错），比"没座位就用回退字典"糟得多。
		* 官方 Skill 的取向也正是"默认 `ctx.get(name)` + 自检缺失，只有真硬依赖才 inject"
		* （`参考-DSH官方文档-20260920/官方Skill-cordis-plugin-development.md` 的 "Access Services" 段）。
		* ⇒ locale 走 `ctx.get('locale')`，缺失时用本地回退字典（同一份 `DICTS`，不是第二份真值）。
		*/
		const inject = ["slots"];
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
				"error.unknownShape": "宿主返回了未知版本的状态（插件与宿主版本不匹配？）",
				"card.today": "考研数学 · 今日题单",
				"card.progress": "考研数学 · 进度",
				"card.running": "读取中…",
				"card.empty": "（没有内容）",
				"card.truncated": "…还有更多行（展开详情可看全）"
			},
			en: {
				"label": "Math Drill",
				"action.refresh": "Refresh",
				"state.loading": "Loading…",
				"error.fetch": "Cannot reach the math-drill status route",
				"error.unknownShape": "The host returned an unknown status shape (plugin/host version mismatch?)",
				"card.today": "Math Drill · today",
				"card.progress": "Math Drill · progress",
				"card.running": "Loading…",
				"card.empty": "(no content)",
				"card.truncated": "…more lines (open details for the full output)"
			}
		};
		/** 注册卡片的工具名（keyed 分发值 = wire 工具名；改这里必须同步 `src/tools.js` 的工具名）。 */
		const TOOL_CARD_KEYS = ["math_drill_progress", "math_drill_today"];
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
			margin: "0 0 6px",
			borderRadius: "999px",
			background: "var(--dsw-alias-bg-layer-1)",
			border: "0.5px solid var(--dsw-alias-border-l2)",
			fontSize: "12px",
			lineHeight: "1.5",
			opacity: .92
		};
		/** 一行式：简报 + 明细留给 `/math` 与卡片（对标物 statusbar / lookatstudy 同形态）。 */
		const TEXT_STYLE = {
			flex: "1 1 auto",
			minWidth: 0,
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
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
						brief: payload.brief ?? payload.text.split("\n")[0],
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
			const body = state.kind === "loading" ? translate(props, "state.loading") : state.kind === "ready" ? state.brief : `⚠️ ${state.message}`;
			return (0, react.createElement)("div", {
				style: BOX_STYLE,
				"data-math-drill": "dock"
			}, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, null, translate(props, "label")), (0, react.createElement)("span", {
				style: TEXT_STYLE,
				title: state.kind === "ready" ? state.text : void 0
			}, body), (0, react.createElement)("button", {
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
			const locale = ctx.get?.("locale");
			if (locale !== void 0) {
				const registerDicts = () => locale.register(NS, DICTS);
				if (typeof ctx.effect === "function") ctx.effect(registerDicts, `${NS}: dictionaries`);
				else registerDicts();
			}
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: SLOT_ID,
				order: 20,
				...locale === void 0 ? {} : { locale: NS }
			}, MathDrillDock));
			for (const key of TOOL_CARD_KEYS) ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key,
				...locale === void 0 ? {} : { locale: NS }
			}, MathDrillCard));
		}
		/** 测试用导出：字典（键对齐与文案断言都在测试里）。 */
		const dictionaries = DICTS;
		/** 测试用导出：文案命名空间。 */
		const localeNamespace = NS;
		//#endregion
		exports.TOOL_CARD_KEYS = TOOL_CARD_KEYS;
		exports.apply = apply;
		exports.dictionaries = dictionaries;
		exports.inject = inject;
		exports.localeNamespace = localeNamespace;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map