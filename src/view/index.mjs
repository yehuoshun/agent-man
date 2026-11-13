// view 门面：渲染三件东西——处境屏、摘要页、记录行。
// 这一层只吃已经算好的普通对象，不读盘、不问时间、不 import 任何业务模块（design §7）：
// 与判断分开，才能拿字面 fixture 把每段字钉死。
export { render as renderScreen } from './screen.mjs'
