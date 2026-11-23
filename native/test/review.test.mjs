// The self-check request appended when checks are supplied.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewRequest } from '../lib/review.js'

test('an English task gets the English review request', () => {
  const text = reviewRequest('Create the report and run the tests.')
  assert.match(text, /read-only sub-agent/)
  assert.match(text, /requirement \| met/)
})

test('a Chinese task gets the Chinese review request', () => {
  const text = reviewRequest('创建报告并运行测试。')
  assert.match(text, /只读子代理/)
  assert.match(text, /需求 \| 是否满足/)
})
