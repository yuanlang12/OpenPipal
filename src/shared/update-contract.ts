/**
 * 版本检查的跨进程契约。
 *
 * 放 shared 是因为渲染层不能 import src/main（tsconfig.web 的边界，也是对的边界）。
 * 契约里**没有 URL**：下载地址在渲染层写死，远端字段永远变不成一个能点的链接。
 */
export type UpdateCheckResult =
  | { status: 'up-to-date'; current: string }
  | { status: 'update-available'; current: string; latest: string }
  | { status: 'unavailable' }
