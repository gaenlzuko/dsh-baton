// Evidence module: snapshot diff and check execution.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepare, collect } from '../lib/evidence.js'

test('prepare/collect reports created and modified files and runs checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baton-evidence-'))
  try {
    const home = path.join(root, 'home')
    const dir = path.join(root, 'work')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one')

    prepare(home, { run_id: 'hrun-e1', session_id: 's1', cwd: dir, checks: ['node --version'] })

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one two')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new')

    const evidence = collect(home, 'hrun-e1')
    assert.ok(evidence, 'expected evidence for the run')
    assert.ok(evidence.changes.modified.some((row) => row.path === 'a.txt'), 'a.txt should be modified')
    assert.ok(evidence.changes.created.some((row) => row.path === 'b.txt'), 'b.txt should be created')
    assert.equal(evidence.checks.length, 1)
    assert.equal(evidence.checks[0].passed, true)
    assert.equal(evidence.all_checks_passed, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('collect returns null for a run that was never prepared', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baton-evidence-'))
  try {
    assert.equal(collect(path.join(root, 'home'), 'hrun-missing'), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
