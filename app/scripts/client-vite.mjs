import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const viteBin = path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const dev = process.argv[2] === 'dev'
const args = [viteBin]
if (dev) args.push('--host', '127.0.0.1', '--port', '5195', '--strictPort')
else args.push('build')

const child = spawn(process.execPath, args, {
  cwd: appRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_BOTCAMP_CLIENT: '1',
    VITE_BOTCAMP_API: 'https://botcamp.demox.site',
  },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
