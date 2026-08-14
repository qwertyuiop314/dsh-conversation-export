/**
 * Host half of dsh-session-conversation-export.
 *
 * 转换逻辑完全在浏览器端执行（fetch /api/session.export 的 ZIP → 本地清洗 → 打包下载），
 * 宿主侧无需任何服务；本入口存在的意义是让 Cordis Loader 装载该包，从而
 * client-modules 扫描到 dsh.client 声明并挂载浏览器 bundle。
 */
const name = "session-conversation-export";
function apply(ctx) {
	ctx.effect(() => () => {}, "session-conversation-export: browser-only feature");
}
export { apply, name };
