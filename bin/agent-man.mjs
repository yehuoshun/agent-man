#!/usr/bin/env node
import { main } from '../src/cli.mjs'

// 大多数命令同步返回退出码；联网的 place / sky 交回 Promise（§25）。
// 这里两个都接住，免得 async 命令的退出码静默丢失。
const code = main()
if (code && typeof code.then === 'function') code.then((c) => (process.exitCode = c))
else process.exitCode = code
