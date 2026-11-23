// Live smoke test for the M1 plugin surface: a fake plugin context must register
// exactly one tool, and that tool must reach the running dsh-baton host.
//
// Run: node test/plugin-smoke.mjs   (needs a Harness with dsh-baton-host running)
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const tools = []
const disposers = []
const logs = []
const log = {
  info: (...args) => logs.push(['info', ...args]),
  debug: (...args) => logs.push(['debug', ...args]),
  warn: (...args) => logs.push(['warn', ...args]),
  error: (...args) => logs.push(['error', ...args]),
}

const ctx = {
  logger: log,
  tools: {
    register(definition) {
      tools.push(definition)
    },
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}

apply(ctx)

assert.equal(tools.length, 1, 'expected exactly one registered tool')
const tool = tools[0]
assert.equal(tool.name, 'baton_workspaces')
assert.equal(typeof tool.execute, 'function')

const text = await tool.execute({}, {})
assert.equal(typeof text, 'string')
assert.match(text, /id: /, 'expected workspace ids in the tool output')
assert.ok(!/Could not reach/.test(text), 'expected the live host to answer')

console.log('baton_workspaces ok')
console.log(text.split('\n').slice(0, 4).join('\n'))

for (const dispose of disposers.reverse()) dispose()
