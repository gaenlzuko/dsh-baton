// Where the dsh-baton host listens.
//
// Adapted from dsh-baton host/lib/socket.js (MIT, Copyright (c) 2026 JialaoLiu).
// Kept in sync with the host so the native plugin speaks the same endpoint on
// Windows (a path maps to a per-user named pipe) and honours the same env vars.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const warned = new Set()

// DSH_BATON_<name>, else the old DSH_BRIDGE_<name>.
export function setting(name, env = process.env) {
  if (env[`DSH_BATON_${name}`] !== undefined) return env[`DSH_BATON_${name}`]
  const old = env[`DSH_BRIDGE_${name}`]
  if (old !== undefined && env === process.env && !warned.has(name)) {
    warned.add(name)
    process.emitWarning(`DSH_BRIDGE_${name} is deprecated; rename it to DSH_BATON_${name}`)
  }
  return old
}

// ~/.dsh-baton, unless only an earlier ~/.dsh-bridge exists.
export function batonHome(env = process.env, home = os.homedir()) {
  const set = setting('HOME', env)
  if (set) return set
  const fresh = path.join(home, '.dsh-baton')
  const old = path.join(home, '.dsh-bridge')
  return !fs.existsSync(fresh) && fs.existsSync(old) ? old : fresh
}

const PIPE_PREFIX = /^\\\\[.?]\\pipe\\/i

// On Windows the same path maps to a named pipe: \\.\pipe\dsh-baton-<hash>.
export function socketEndpoint(p, platform = process.platform, prefix = 'dsh-baton') {
  if (platform !== 'win32' || PIPE_PREFIX.test(p)) return p
  const key = path.win32.resolve(p).toLowerCase()
  return `\\\\.\\pipe\\${prefix}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

export const socketPath = (env = process.env) => setting('SOCKET', env) || path.join(batonHome(env), 'host.sock')

// Where a client looks for the host: the current endpoint, then the pre-rename one.
export function hostEndpoints(env = process.env, platform = process.platform) {
  const p = socketPath(env)
  return [...new Set([socketEndpoint(p, platform), socketEndpoint(p, platform, 'dsh-bridge')])]
}
