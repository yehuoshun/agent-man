// store 门面：跨目录只准 import 这一层（AGENTS 四），具体文件住在同层。
export { VERSION, validate, checkHome } from './schema.mjs'
export { home, ensure, eventsFile, stateFile } from './paths.mjs'
