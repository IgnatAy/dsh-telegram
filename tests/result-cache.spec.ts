import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelegramResultCache } from '../src/result-cache.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function cache() {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-cache-'))
  directories.push(directory)
  return new TelegramResultCache('123:secret', directory)
}
const offline = async () => { throw new Error('offline') }

it('keeps only the latest output per chat, isolates chats and survives failed resend', async () => {
  const store = await cache()
  await expect(store.deliver(7, 'old', offline)).rejects.toThrow('offline')
  await expect(store.deliver(8, 'other chat', offline)).rejects.toThrow('offline')
  await expect(store.deliver(7, 'new', offline)).rejects.toThrow('offline')
  expect((await readdir(store.directory)).sort()).toEqual(['7.json', '8.json'])
  await expect(store.resend(7, offline)).rejects.toThrow('offline')
  const send = vi.fn(async () => {})
  expect(await store.resend(7, send)).toBe(true)
  expect(send).toHaveBeenCalledWith('new')
  expect(await store.resend(7, send)).toBe(false)
  expect(await readdir(store.directory)).toEqual(['8.json'])
})

it('serializes resend with newer output so an older acknowledgement cannot delete the new cache', async () => {
  const store = await cache()
  await expect(store.deliver(7, 'old', offline)).rejects.toThrow()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const resend = store.resend(7, async () => { started(); await pending })
  await entered
  const newer = expect(store.deliver(7, 'new', offline)).rejects.toThrow('offline')
  release()
  await resend
  await newer
  const send = vi.fn(async () => {})
  await store.resend(7, send)
  expect(send).toHaveBeenCalledWith('new')
  expect(await readdir(store.directory)).toEqual([])
})

it('removes the cache immediately after normal delivery succeeds', async () => {
  const store = await cache()
  await store.deliver(7, 'answer', async () => {
    expect(await readdir(store.directory)).toEqual(['7.json'])
  })
  expect(await readdir(store.directory)).toEqual([])
})
