window.__ModuleLoader__.load({
	id: "@math-drill/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.ts
		/** 宿主半边挂的只读摘要路由（见 src/index.js）。 */
		const SUMMARY_PATH = "/math-drill/summary";
		/** 本插件需要的浏览器服务：只要槽位（不碰 locale / store / remote）。 */
		const inject = ["slots"];
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
			border: "1px solid var(--dsh-border, rgba(128,128,128,0.35))",
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
			border: "1px solid currentColor",
			background: "transparent",
			color: "inherit",
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
		function MathDrillDock() {
			const [state, setState] = (0, react.useState)({ kind: "loading" });
			const load = (0, react.useCallback)(async () => {
				setState({ kind: "loading" });
				try {
					const payload = await (await fetch(SUMMARY_PATH, { headers: { Accept: "application/json" } })).json();
					setState(payload.ok ? {
						kind: "ready",
						text: payload.text
					} : {
						kind: "failed",
						message: payload.error
					});
				} catch (error) {
					setState({
						kind: "failed",
						message: `取不到考研数学摘要：${error instanceof Error ? error.message : String(error)}`
					});
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const body = state.kind === "loading" ? "读取中…" : state.kind === "ready" ? state.text : `⚠️ ${state.message}`;
			return (0, react.createElement)("div", {
				style: BOX_STYLE,
				"data-math-drill": "dock"
			}, (0, react.createElement)("span", { style: LABEL_STYLE }, "考研数学"), (0, react.createElement)("span", { style: TEXT_STYLE }, body), (0, react.createElement)("button", {
				type: "button",
				style: BUTTON_STYLE,
				onClick: () => {
					load();
				}
			}, "刷新"));
		}
		/**
		* 挂载客户端半边：往 `conversation.input.dock` 追加一条。
		*
		* @param ctx - DSH 客户端上下文（cordis）。
		*/
		function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: SLOT_ID,
				order: 20
			}, MathDrillDock));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map