#!/usr/bin/env node
import { main } from '../src/cli/index.mjs'

// 薄壳：只接退出码，不放逻辑（AGENTS 四）。命令的实现全在 src/cli/ 后面，
// 这里多写一行都会让"入口"长成第二个真源。栈交给 Node 自己打，不吞异常。
process.exitCode = await main(process.argv.slice(2), { env: process.env })
