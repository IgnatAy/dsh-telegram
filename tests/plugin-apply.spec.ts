import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as telegram from '../src/index.ts'
import type { TelegramClientLike } from '../src/client.ts'

/**
 * Mount the real namespace plugin on a real Context with its injected DSH
 * services stubbed, using a fake client seam.
 * Covers the full mount/poll/dispose lifecycle and the fail-loud missing-token
 * path; message flow is covered by the bridge unit tests because a turn needs
 * a live LLM adapter.
 *
 * The original spec mounted `@deepseek-ai/dsh-agent-spine-demo` to provide
 * `agents`, but that package is not shipped with the npx-installed dsh, so a
 * stub keeps the suite runnable in this environment.
 */

async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function fakeClient(): TelegramClientLike & { polls: number } {
  const client = {
    polls: 0,
    async getMe() {
      return { id: 1, is_bot: true }
    },
    async getUpdates() {
      client.polls += 1
      return []
    },
    async sendMessage() {
      return { message_id: 1, chat: { id: 7, type: 'private' }, date: 0 }
    },
    async sendChatAction() {
      return true
    },
    async setMyCommands() {
      return true
    },
    async editMessageText(chatId: number, messageId: number) {
      return { message_id: messageId, chat: { id: chatId, type: 'private' }, date: 0 }
    },
    async editMessageReplyMarkup(chatId: number, messageId: number) {
      return { message_id: messageId, chat: { id: chatId, type: 'private' }, date: 0 }
    },
    async answerCallbackQuery() {
      return true
    },
    async deleteMessage() {
      return true
    },
    async deleteMessages() {
      return true
    },
    async downloadFile(fileId: string) {
      return {
        file: { file_id: fileId, file_unique_id: `unique-${fileId}`, file_path: `photos/${fileId}` },
        data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      }
    },
  }
  return client
}

/** Minimal `agents` service: never invoked because the fake client yields no updates. */
function stubAgents() {
  return {
    async create() {
      return {
        agent: { followup() {}, cancel() {}, status: 'idle' as const },
        async dispose() {},
      }
    },
  }
}

function contextWithAgents(): Context {
  const ctx = new Context()
  ctx.provide('agents', stubAgents())
  ctx.provide('agentPresets', {
    async resolve(id?: string) {
      return { id: id ?? 'standard' }
    },
    async mount() {},
  } as unknown as Context['agentPresets'])
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 4096,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async validateImage() {},
    async saveImages() { return [] },
  } as unknown as Context['attachments'])
  ctx.provide('llm', {
    listProviders() { return [] },
    async listModels() { return [] },
    async resolveModelInfo(provider: string, model: string) {
      return { provider, id: model, name: model }
    },
    async resolveCallConfig(config: unknown) { return config },
  } as unknown as Context['llm'])
  ctx.provide('sessionController', {
    async selectModel(request: { provider: string; model: string; reasoningEffort?: string }) {
      return {
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        },
      }
    },
  } as unknown as Context['sessionController'])
  ctx.provide('sessionPersistence', {} as Context['sessionPersistence'])
  ctx.provide('sessionQuery', {} as Context['sessionQuery'])
  ctx.provide('systemPrompt', {} as Context['systemPrompt'])
  ctx.provide('workspaceRegistry', {} as Context['workspaceRegistry'])
  return ctx
}

describe('dsh-telegram plugin apply', () => {
  it('mounts on the agents service, polls through the client seam, and disposes cleanly', async () => {
    const client = fakeClient()
    const ctx = contextWithAgents()
    await ctx.plugin(telegram, { token: 'test-token', client, sleep: async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) })
    await waitFor(() => client.polls > 0 ? true : undefined, 'first poll')
    const pollsAtMount = client.polls
    await ctx.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(client.polls).toBe(pollsAtMount)
  })

  it('fails loudly at load when the token is missing', async () => {
    const ctx = contextWithAgents()
    await expect(ctx.plugin(telegram, {})).rejects.toThrow('missing bot token')
  })

  it('falls back to the DSH_TELEGRAM_TOKEN environment variable', async () => {
    const previous = process.env.DSH_TELEGRAM_TOKEN
    process.env.DSH_TELEGRAM_TOKEN = 'env-token'
    try {
      const client = fakeClient()
      const ctx = contextWithAgents()
      await ctx.plugin(telegram, { client, sleep: async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) })
      await waitFor(() => client.polls > 0 ? true : undefined, 'first poll')
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_TELEGRAM_TOKEN
      } else {
        process.env.DSH_TELEGRAM_TOKEN = previous
      }
    }
  })

  it('rejects an empty token from the environment', async () => {
    const previous = process.env.DSH_TELEGRAM_TOKEN
    process.env.DSH_TELEGRAM_TOKEN = ''
    try {
      const ctx = contextWithAgents()
      await expect(ctx.plugin(telegram, {})).rejects.toThrow('missing bot token')
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_TELEGRAM_TOKEN
      } else {
        process.env.DSH_TELEGRAM_TOKEN = previous
      }
    }
  })

  it('reads the allowlist from DSH_TELEGRAM_ALLOWED_USER_IDS when config leaves it empty', async () => {
    const previous = process.env.DSH_TELEGRAM_ALLOWED_USER_IDS
    process.env.DSH_TELEGRAM_ALLOWED_USER_IDS = '111,222'
    try {
      const ctx = contextWithAgents()
      // Mount with a client seam; the allowlist fallback is exercised inside
      // apply before the bridge starts, so a successful mount is the assertion.
      await ctx.plugin(telegram, { token: 'test-token', client: fakeClient(), sleep: async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) })
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_TELEGRAM_ALLOWED_USER_IDS
      } else {
        process.env.DSH_TELEGRAM_ALLOWED_USER_IDS = previous
      }
    }
  })

  it('rejects malformed allowlist environment values instead of silently dropping them', async () => {
    const previous = process.env.DSH_TELEGRAM_ALLOWED_USER_IDS
    process.env.DSH_TELEGRAM_ALLOWED_USER_IDS = '111,not-a-user'
    try {
      const ctx = contextWithAgents()
      await expect(ctx.plugin(telegram, { token: 'test-token', client: fakeClient() }))
        .rejects.toThrow('comma-separated positive integer')
    } finally {
      if (previous === undefined) delete process.env.DSH_TELEGRAM_ALLOWED_USER_IDS
      else process.env.DSH_TELEGRAM_ALLOWED_USER_IDS = previous
    }
  })

  it('lets explicit allowAllUsers false bypass the environment fallback', async () => {
    const previous = process.env.DSH_TELEGRAM_ALLOW_ALL_USERS
    process.env.DSH_TELEGRAM_ALLOW_ALL_USERS = 'not-a-boolean'
    try {
      const ctx = contextWithAgents()
      await ctx.plugin(telegram, { token: 'test-token', allowAllUsers: false, client: fakeClient() })
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_TELEGRAM_ALLOW_ALL_USERS
      else process.env.DSH_TELEGRAM_ALLOW_ALL_USERS = previous
    }
  })
})
