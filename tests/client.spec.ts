import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { TelegramClient } from '../src/client.ts'

/** Mock with a fetch-shaped call signature: keeps mock.calls typed and the value assignable. */
type FetchSeam = Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>

/** Build a fetch seam mock; plain vi.fn inference would narrow calls to an empty tuple. */
function fetchMock(impl: () => Promise<Response>): FetchSeam {
  return vi.fn(impl)
}

/** Build a fake Response with the given JSON payload and status. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('TelegramClient', () => {
  it('rejects an empty token', () => {
    expect(() => new TelegramClient('')).toThrow('token must not be empty')
  })

  it('defaults the API base URL and polling timeout', () => {
    const client = new TelegramClient('t:ok')
    expect(client.pollingTimeoutSec).toBe(30)
  })

  it('rejects a non-positive polling timeout', () => {
    expect(() => new TelegramClient('t:ok', { pollingTimeoutSec: 0 })).toThrow('positive integer')
  })

  it('getMe returns the bot user', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: { id: 1, is_bot: true } }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).resolves.toEqual({ id: 1, is_bot: true })
    const url = fetchImpl.mock.calls[0]?.[0] as string
    expect(url).toBe('https://api.telegram.org/bott:ok/getMe')
  })

  it('normalizes surrounding token whitespace and a trailing base URL slash', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: { id: 1, is_bot: true } }))
    const client = new TelegramClient('  t:ok  ', {
      fetch: fetchImpl as typeof fetch,
      baseUrl: 'http://localhost:8080/',
    })
    await client.getMe()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8080/bott:ok/getMe')
  })

  it('getUpdates passes the acknowledged offset and polling timeout', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: [] }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch, pollingTimeoutSec: 15 })
    await client.getUpdates(42)
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toMatchObject({ offset: 42, timeout: 15, allowed_updates: ['message', 'callback_query'] })
  })

  it('getUpdates omits offset when starting fresh', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: [] }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await client.getUpdates()
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body.offset).toBeUndefined()
  })

  it('forwards an abort signal to fetch', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: [] }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    const controller = new AbortController()
    await client.getUpdates(undefined, controller.signal)
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal)
  })

  it('sendMessage forwards parse mode only when requested', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: { message_id: 1, chat: { id: 7, type: 'private' }, date: 0 } }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await client.sendMessage(7, 'hi')
    let body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toEqual({ chat_id: 7, text: 'hi' })
    await client.sendMessage(7, '<b>hi</b>', 'HTML')
    body = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toMatchObject({ parse_mode: 'HTML' })
  })

  it('sendMessage forwards inline keyboards and ForceReply markup', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({
      ok: true,
      result: { message_id: 1, chat: { id: 7, type: 'private' }, date: 0 },
    }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    const keyboard = { inline_keyboard: [[{ text: 'Yes', callback_data: 'uq:token:0:o0' }]] }
    await client.sendMessage(7, 'Choose', undefined, undefined, keyboard)
    let body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body.reply_markup).toEqual(keyboard)

    await client.sendMessage(7, 'Reply', undefined, undefined, {
      force_reply: true,
      input_field_placeholder: 'Your answer',
    })
    body = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body.reply_markup).toEqual({ force_reply: true, input_field_placeholder: 'Your answer' })
  })

  it('sendChatAction posts the action', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: true }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.sendChatAction(7, 'typing')).resolves.toBe(true)
  })

  it('uses the Bot API result types for editing and deleting messages', async () => {
    const edited = { message_id: 8, chat: { id: 7, type: 'private' }, date: 0 }
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: edited }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.editMessageText(7, 8, 'updated')).resolves.toEqual(edited)

    fetchImpl.mockImplementationOnce(async () => jsonResponse({ ok: true, result: true }))
    await expect(client.deleteMessage(7, 8)).resolves.toBe(true)
  })

  it('updates keyboards and acknowledges callback queries', async () => {
    const edited = { message_id: 8, chat: { id: 7, type: 'private' }, date: 0 }
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: edited }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await client.editMessageReplyMarkup(7, 8)
    let url = fetchImpl.mock.calls[0]?.[0] as string
    let body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(url).toContain('/editMessageReplyMarkup')
    expect(body).toEqual({ chat_id: 7, message_id: 8, reply_markup: { inline_keyboard: [] } })

    fetchImpl.mockImplementationOnce(async () => jsonResponse({ ok: true, result: true }))
    await client.answerCallbackQuery('callback-1', 'Done', true)
    url = fetchImpl.mock.calls[1]?.[0] as string
    body = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(url).toContain('/answerCallbackQuery')
    expect(body).toEqual({ callback_query_id: 'callback-1', text: 'Done', show_alert: true })
  })

  it('deletes multiple messages in one Bot API request', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: true }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.deleteMessages(7, [11, 12, 13])).resolves.toBe(true)
    const url = fetchImpl.mock.calls[0]?.[0] as string
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(url).toContain('/deleteMessages')
    expect(body).toEqual({ chat_id: 7, message_ids: [11, 12, 13] })
    expect(() => client.deleteMessages(7, [])).toThrow('1 to 100')
    expect(() => client.deleteMessages(7, Array.from({ length: 101 }, (_, index) => index + 1))).toThrow('1 to 100')
  })

  it('resolves and downloads Telegram files under the requested byte cap', async () => {
    const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: {} }))
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: {
          file_id: 'photo-id',
          file_unique_id: 'photo-unique',
          file_size: bytes.byteLength,
          file_path: 'photos/photo.png',
        },
      }))
      .mockResolvedValueOnce(new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })

    await expect(client.downloadFile('photo-id', 1024)).resolves.toMatchObject({
      file: { file_path: 'photos/photo.png' },
      data: bytes,
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.telegram.org/bott:ok/getFile')
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ file_id: 'photo-id' })
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.telegram.org/file/bott:ok/photos/photo.png')
  })

  it('rejects Telegram downloads that exceed their declared or streamed byte cap', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: {} }))
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: { file_id: 'large', file_unique_id: 'large-u', file_size: 11, file_path: 'files/large.bin' },
    }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.downloadFile('large', 10)).rejects.toThrow('file exceeds 10 bytes')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: { file_id: 'lying', file_unique_id: 'lying-u', file_path: 'files/lying.bin' },
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.of(1, 2, 3, 4, 5, 6)))
    await expect(client.downloadFile('lying', 5)).rejects.toThrow('file exceeds 5 bytes')
  })

  it('redacts the bot token from Telegram file-download transport failures', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: {} }))
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: { file_id: 'f', file_unique_id: 'u', file_path: 'files/f.png' },
      }))
      .mockRejectedValueOnce(new Error('download from bott:ok failed'))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.downloadFile('f', 10)).rejects.toThrow('download from bot*** failed')
  })

  it('redacts thrown non-Error values from transport errors', async () => {
    const fetchImpl = fetchMock(async () => { throw 'raw failure with bott:ok' })
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe transport error: raw failure with bot***')
  })

  it('throws a redacted error on transport failure', async () => {
    const fetchImpl = fetchMock(async () => { throw new Error('connect failed to bott:ok') })
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe transport error: connect failed to bot***')
  })

  it('throws a redacted error on a non-ok response', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(
      { ok: false, description: 'Unauthorized for bott:ok' },
      401,
    ))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe failed: Unauthorized for bot***')
  })

  it('throws with the HTTP status when the response is not JSON', async () => {
    const fetchImpl = fetchMock(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe failed: invalid JSON response (HTTP 502)')
  })

  it('rejects a successful response that omits result', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('response omitted result')
  })

  it('honors a custom base URL', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: { id: 1, is_bot: true } }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch, baseUrl: 'http://localhost:8080' })
    await client.getMe()
    expect((fetchImpl.mock.calls[0]?.[0] as string).startsWith('http://localhost:8080/bott:ok/getMe')).toBe(true)
  })
})
