import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from './src/cli/index.mjs'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
const part = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgpart-'))
fs.writeFileSync(path.join(part, 'agent-man-slow.cmd'), ['@echo off','ping -n 5 127.0.0.1 >nul',
  'echo {"name":"slow","desc":"slow part","section":"env","timeout_ms":5000,"side_effects":false}',''].join('\r\n'))
fs.writeFileSync(path.join(dir, 'config.json'), '{"version":1,"parts":{"timeout":200}}\n')
const env = { AGENT_MAN_HOME: dir, PATH: part, ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot }
const out = [], err = []
const t = Date.now()
const code = await main(['context','sense'], { env, out: l=>out.push(l), err: l=>err.push(l), now: ()=>Date.now() })
console.log('code', code, 'spent', Date.now()-t)
console.log('OUT:', JSON.stringify(out))
console.log('ERR:', JSON.stringify(err))
