import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TelegramBridge } from '../src/bridge.ts'
import type { TelegramBridgeOptions } from '../src/bridge.ts'
import type { TelegramClientLike, TelegramDownloadedFile, TelegramMessage, TelegramReplyMarkup, TelegramUpdate } from '../src/client.ts'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface FakeAgent {
  session: { id: string; header: SessionHeader }
  status: 'idle' | 'running'
  ctx: Context
  handlers: Map<string, Array<(...args: never[]) => unknown>>
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

interface FakeHandle {
  agent: FakeAgent
  dispose: ReturnType<typeof vi.fn>
}

let current: Harness | undefined
afterEach(async () => {
  await current?.bridge.stop()
  current = undefined
})

type Mock = ReturnType<typeof vi.fn>

interface Harness {
  bridge: TelegramBridge
  client: TelegramClientLike & {
    getMe: Mock
    getUpdates: Mock
    sendMessage: Mock
    sendChatAction: Mock
    setMyCommands: Mock
    editMessageText: Mock
    editMessageReplyMarkup: Mock
    answerCallbackQuery: Mock
    deleteMessage: Mock
    deleteMessages: Mock
    downloadFile: Mock
  }
  ctx: {
    on: Mock
    get: Mock
    agents: { create: Mock; resume: Mock; get: Mock }
    attachments: { imageLimits: ImageAttachmentLimits; validateImage: Mock; saveImages: Mock }
    llm: { listProviders: Mock; listModels: Mock; resolveModelInfo: Mock; resolveCallConfig: Mock }
    sessionPersistence: { locate: Mock; load: Mock }
    sessionQuery: { listSessions: Mock; readTitleSnapshots: Mock }
    sessionController: { selectModel: Mock }
    workspaceRegistry: { list: Mock; resolveByPath: Mock; archivedSessionIds: string[] }
    logger: { warn: Mock; error: Mock }
  }
  presetMount: Mock
  agents: FakeHandle[]
  sent: { messageId: number; chatId: number; text: string; parseMode?: 'HTML'; replyMarkup?: TelegramReplyMarkup }[]
  actions: { chatId: number; action: string }[]
  polls: (number | undefined)[]
  sleeps: number[]
  workspaces: Workspace[]
  headers: Map<string, SessionHeader>
  emit(sessionId: string, event: SessionEvent): void
}

interface HarnessSession {
  id: string
  cwd: string
  title?: string
  agentPreset?: string
  archived?: boolean
  location?: string
}

interface HarnessWorkspace {
  path: string
  title: string
  sessionIds?: string[]
  status?: 'ok' | 'missing-dir'
}

interface HarnessModel {
  provider: string
  providerName: string
  id: string
  name: string
  description?: string
  efforts?: { id: string; name: string; description?: string }[]
  defaultEffort?: string
  inputModalities?: Array<'text' | 'image'>
}

interface HarnessSetup {
  workspaces?: HarnessWorkspace[]
  sessions?: HarnessSession[]
  models?: HarnessModel[]
  liveSessionIds?: string[]
}

/** Poll an async condition for up to five seconds. */
async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Drain asynchronous work before a negative assertion. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

function createHarness(
  options: Partial<TelegramBridgeOptions> = {},
  setup: HarnessSetup = {},
): Harness {
  const sent: Harness['sent'] = []
  const actions: Harness['actions'] = []
  const polls: Harness['polls'] = []
  const sleeps: Harness['sleeps'] = []
  const agents: FakeHandle[] = []
  const liveAgents = new Map<string, FakeAgent>()
  const sessionSpecs = setup.sessions ?? []
  const modelSpecs = setup.models ?? [
    {
      provider: 'deepseek-official',
      providerName: 'DeepSeek',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    },
    {
      provider: 'deepseek-official',
      providerName: 'DeepSeek',
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    },
  ] satisfies HarnessModel[]
  const headers = new Map<string, SessionHeader>()
  const titles = new Map<string, string>()
  const locations = new Map<string, string>()
  let nextMessageId = 1
  for (const session of sessionSpecs) {
    headers.set(session.id, {
      version: 0,
      isSeeded: false,
      id: SessionId(session.id),
      cwd: session.cwd,
      createdAt: 1,
      ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
    } satisfies SessionHeader)
    if (session.title !== undefined) titles.set(session.id, session.title)
    if (session.location !== undefined) locations.set(session.id, session.location)
  }
  const workspaceSpecs = setup.workspaces ?? [{ path: '/workspace', title: 'workspace' }]
  const mutableWorkspaceSessions = workspaceSpecs.map(spec => [...(spec.sessionIds ?? [])])
  const workspaces = workspaceSpecs.map((spec, index): Workspace => ({
    id: `workspace-${index + 1}`,
    path: spec.path,
    title: spec.title,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    get sessionIds() { return mutableWorkspaceSessions[index]!.map(SessionId) },
    setTitle: vi.fn(),
    attachSession: vi.fn(async (id: string) => {
      if (!mutableWorkspaceSessions[index]!.includes(id)) mutableWorkspaceSessions[index]!.unshift(id)
    }),
    insertSessionBefore: vi.fn(),
    detachSession: vi.fn(async (id: string) => {
      const position = mutableWorkspaceSessions[index]!.indexOf(id)
      if (position >= 0) mutableWorkspaceSessions[index]!.splice(position, 1)
    }),
    status: vi.fn(async () => spec.status ?? 'ok'),
  } as unknown as Workspace))
  let listener: ((session: { id: string }, event: SessionEvent) => void) | undefined
  const presetMount = vi.fn(async () => {})
  const client: TelegramClientLike & {
    getMe: Mock
    getUpdates: Mock
    sendMessage: Mock
    sendChatAction: Mock
    setMyCommands: Mock
    editMessageText: Mock
    editMessageReplyMarkup: Mock
    answerCallbackQuery: Mock
    deleteMessage: Mock
    deleteMessages: Mock
    downloadFile: Mock
  } = {
    getMe: vi.fn(async () => ({ id: 1, is_bot: true })),
    getUpdates: vi.fn(async (offset?: number) => { polls.push(offset); return [] as TelegramUpdate[] }),
    sendMessage: vi.fn(async (
      chatId: number,
      text: string,
      parseMode?: 'HTML',
      _signal?: AbortSignal,
      replyMarkup?: TelegramReplyMarkup,
    ) => {
      const messageId = nextMessageId
      nextMessageId += 1
      sent.push({
        messageId,
        chatId,
        text,
        ...(parseMode === undefined ? {} : { parseMode }),
        ...(replyMarkup === undefined ? {} : { replyMarkup }),
      })
      return { message_id: messageId, chat: { id: chatId, type: 'private' }, date: 0 }
    }),
    sendChatAction: vi.fn(async (chatId: number, action: string) => {
      actions.push({ chatId, action })
      return true
    }),
    setMyCommands: vi.fn(async () => true),
    editMessageText: vi.fn(async (chatId: number, messageId: number) => ({
      message_id: messageId,
      chat: { id: chatId, type: 'private' },
      date: 0,
    })),
    editMessageReplyMarkup: vi.fn(async (chatId: number, messageId: number) => ({
      message_id: messageId,
      chat: { id: chatId, type: 'private' },
      date: 0,
    })),
    answerCallbackQuery: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    deleteMessages: vi.fn(async () => true),
    downloadFile: vi.fn(async (fileId: string): Promise<TelegramDownloadedFile> => ({
      file: { file_id: fileId, file_unique_id: `unique-${fileId}`, file_path: `photos/${fileId}` },
      data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    })),
  }
  const makeHandle = (id: string, header: SessionHeader): FakeHandle => {
    const handlers = new Map<string, Array<(...args: never[]) => unknown>>()
    const agentCtx = {
      systemPrompt: { context: vi.fn(() => vi.fn()) },
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        const entries = handlers.get(event) ?? []
        entries.push(handler)
        handlers.set(event, entries)
        return () => {
          const position = entries.indexOf(handler)
          if (position >= 0) entries.splice(position, 1)
          return true
        }
      }),
    } as unknown as Context
    const agent: FakeAgent = {
      session: { id, header },
      status: 'idle',
      ctx: agentCtx,
      handlers,
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
    }
    const handle: FakeHandle = {
      agent,
      dispose: vi.fn(async () => { liveAgents.delete(id) }),
    }
    agents.push(handle)
    liveAgents.set(id, agent)
    return handle
  }
  for (const id of setup.liveSessionIds ?? []) {
    const header = headers.get(id)
    if (header === undefined) throw new Error(`live test session ${id} has no header`)
    makeHandle(id, header)
    agents.pop()
  }
  const resolvedModel = (provider: string, model: string): LlmResolvedModelInfo => {
    const spec = modelSpecs.find(candidate => candidate.provider === provider && candidate.id === model)
    if (spec === undefined) throw new Error(`unknown model ${provider}/${model}`)
    return {
      provider: spec.provider,
      id: spec.id,
      name: spec.name,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(spec.inputModalities === undefined ? {} : { inputModalities: spec.inputModalities }),
      ...(spec.efforts === undefined ? {} : {
        reasoning: {
          efforts: spec.efforts.map(effort => ({
            id: ReasoningEffortId(effort.id),
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
          ...(spec.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(spec.defaultEffort) }),
        },
      }),
    }
  }
  const ctx: Harness['ctx'] = {
    on: vi.fn((_event: string, l: typeof listener) => {
      listener = l
      return () => { listener = undefined }
    }),
    get: vi.fn((service: string) => service === 'agentPresets' ? { mount: presetMount } : undefined),
    agents: {
      create: vi.fn(async (opts: { sessionId: string; meta: { cwd: string; agentPreset?: string } }) => {
        const header = {
          version: 0,
          isSeeded: false,
          id: SessionId(opts.sessionId),
          cwd: opts.meta.cwd,
          createdAt: 1,
          ...(opts.meta.agentPreset === undefined ? {} : { agentPreset: opts.meta.agentPreset }),
        } satisfies SessionHeader
        headers.set(opts.sessionId, header)
        return makeHandle(opts.sessionId, header)
      }),
      resume: vi.fn(async (opts: { resumeSessionId: string }) => {
        const id = String(opts.resumeSessionId)
        if (liveAgents.has(id)) throw new Error(`cannot prepare session "${id}" while it is live`)
        const header = headers.get(id)
        if (header === undefined) throw new Error(`unknown session ${id}`)
        return makeHandle(id, header)
      }),
      get: vi.fn((id: string) => liveAgents.get(String(id))),
    },
    attachments: {
      imageLimits: {
        maxImageBytes: 10 * 1024 * 1024,
        maxImagesPerMessage: 8,
        maxMessageImageBytes: 20 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        maxImageDimension: 16_384,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      validateImage: vi.fn(async (_input: SaveImageAttachment) => {}),
      saveImages: vi.fn(async (inputs: readonly SaveImageAttachment[]) => inputs.map((input, index) => ({
        attachmentId: `telegram-test-${index}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...(input.name === undefined ? {} : { name: input.name }),
      })) as unknown as ImageAttachmentRef[]),
    },
    llm: {
      listProviders: vi.fn(() => [...new Map(modelSpecs.map(model => [model.provider, {
        id: model.provider,
        name: model.providerName,
      }])).values()]),
      listModels: vi.fn(async (provider: string) => modelSpecs
        .filter(model => model.provider === provider)
        .map(model => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
        }))),
      resolveModelInfo: vi.fn(async (provider: string, model: string) => resolvedModel(provider, model)),
      resolveCallConfig: vi.fn(async (config: LlmCallConfig) => {
        const info = resolvedModel(config.provider, config.model)
        if (config.reasoningEffort !== undefined
          && !info.reasoning?.efforts.some(effort => effort.id === config.reasoningEffort)) {
          throw new Error(`unsupported reasoning effort ${config.reasoningEffort}`)
        }
        return config
      }),
    },
    sessionPersistence: {
      locate: vi.fn((header: SessionHeader) => {
        const path = locations.get(String(header.id))
        return path === undefined ? undefined : { kind: 'jsonl', path }
      }),
      load: vi.fn(async (id: string) => ({ meta: headers.get(String(id)), events: [] })),
    },
    sessionQuery: {
      listSessions: vi.fn(async () => [...headers.values()].map(header => ({ header, availability: 'available' }))),
      readTitleSnapshots: vi.fn(async (ids: string[]) => ids.map(id => ({
        status: 'fulfilled',
        sessionId: id,
        value: {
          session: headers.get(String(id)),
          title: titles.has(String(id)) ? { title: titles.get(String(id)) } : undefined,
        },
      }))),
    },
    sessionController: {
      selectModel: vi.fn(async (request: {
        provider: string
        model: string
        reasoningEffort?: ReturnType<typeof ReasoningEffortId>
      }) => ({
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        },
      })),
    },
    workspaceRegistry: {
      list: vi.fn(() => workspaces),
      resolveByPath: vi.fn(async (path: string) => workspaces.find(workspace => workspace.path === path)),
      archivedSessionIds: sessionSpecs.filter(session => session.archived).map(session => session.id),
    },
    logger: { warn: vi.fn(), error: vi.fn() },
  }
  const bridge = new TelegramBridge(ctx as unknown as Context, {
    token: 't:ok',
    client,
    sleep: async (ms: number) => { sleeps.push(ms); await new Promise(resolve => setTimeout(resolve, ms)) },
    // Most tests exercise message flow; the authorization tests opt out.
    allowAllUsers: true,
    ...options,
  })
  const harness: Harness = {
    bridge,
    client,
    ctx,
    agents,
    sent,
    actions,
    polls,
    sleeps,
    workspaces,
    headers,
    presetMount,
    emit(sessionId: string, event: SessionEvent): void {
      listener?.({ id: sessionId }, event)
    },
  }
  current = harness
  return harness
}

/** Select a newly created session in the default workspace, then hide the command reply. */
async function selectNew(h: Harness, updateId = 1): Promise<FakeHandle> {
  h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/use 1 0' }), update_id: updateId }])
  const handle = await waitFor(() => h.agents.at(-1), 'new selected agent')
  await waitFor(() => h.sent.some(message => message.text.includes('创建并进入会话')) ? true : undefined, 'selection reply')
  h.sent.length = 0
  h.client.sendMessage.mockClear()
  return handle
}

function update(message: Partial<Omit<TelegramMessage, 'message_id' | 'chat' | 'from'> & {
  chatId: number
  fromId: number
  messageId: number
}> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: message.messageId ?? 1,
      chat: { id: message.chatId ?? 7, type: 'private' },
      from: { id: message.fromId ?? 42 },
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.caption === undefined ? {} : { caption: message.caption }),
      ...(message.photo === undefined ? {} : { photo: message.photo }),
      ...(message.document === undefined ? {} : { document: message.document }),
      ...(message.reply_to_message === undefined ? {} : { reply_to_message: message.reply_to_message }),
      date: 0,
    },
  }
}

function callbackUpdate(data: string, updateId: number, messageId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 42 },
      message: {
        message_id: messageId,
        chat: { id: 7, type: 'private' },
        date: 0,
      },
      data,
    },
  }
}

interface TestQuestionRequest {
  questions: Array<{
    id: string
    question: string
    detail?: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
  signal?: AbortSignal
}

interface TestQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

type TestQuestionHandler = (
  request: TestQuestionRequest,
  next: () => Promise<TestQuestionAnswer>,
) => Promise<TestQuestionAnswer>

/** Return the Telegram question listener attached while the fake Agent is selected. */
async function installQuestionHandler(h: Harness, handle: FakeHandle): Promise<TestQuestionHandler> {
  await Promise.resolve()
  const handler = handle.agent.handlers.get('user-questions/request')?.at(-1)
  if (handler === undefined) throw new Error('question handler was not installed')
  return handler as unknown as TestQuestionHandler
}

function inlineKeyboard(message: Harness['sent'][number]): { inline_keyboard: readonly (readonly { text: string; callback_data: string }[])[] } {
  const markup = message.replyMarkup
  if (markup === undefined || !('inline_keyboard' in markup)) throw new Error('message has no inline keyboard')
  return markup
}

describe('TelegramBridge', () => {
  it('start registers the session listener and begins polling', async () => {
    const h = createHarness()
    h.bridge.start()
    expect(h.ctx.on).toHaveBeenCalledWith('session/event', expect.any(Function))
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'first poll')
    await waitFor(() => h.client.setMyCommands.mock.calls[0] ? true : undefined, 'command registration')
    const commands = h.client.setMyCommands.mock.calls[0]?.[0] as { command: string }[]
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'start' }),
      expect.objectContaining({ command: 'use' }),
      expect.objectContaining({ command: 'model' }),
      expect.objectContaining({ command: 'collect' }),
      expect.objectContaining({ command: 'send' }),
      expect.objectContaining({ command: 'discard' }),
      expect.objectContaining({ command: 'followup' }),
      expect.objectContaining({ command: 'reasoning' }),
    ]))
    expect(commands.map(entry => entry.command)).not.toContain('list')
  })

  it('/use without arguments numbers every workspace and its titled sessions', async () => {
    const h = createHarness({}, {
      workspaces: [
        { path: '/telegram', title: 'telegram', sessionIds: ['s-a', 's-b'] },
        { path: '/playground', title: 'playground', sessionIds: ['s-c'] },
      ],
      sessions: [
        { id: 's-a', cwd: '/telegram', title: '第一段会话' },
        { id: 's-b', cwd: '/telegram', title: '第二段会话', archived: true },
        { id: 's-c', cwd: '/playground', title: '实验会话' },
      ],
    })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use' })])
    const reply = await waitFor(() => h.sent[0], 'catalog reply')
    expect(reply.parseMode).toBe('HTML')
    expect(reply.text).toContain('<b>1. telegram</b>')
    expect(reply.text).toContain('<b>1.1</b>　第一段会话')
    expect(reply.text).toContain('<b>1.2</b>　第二段会话　📦 已归档')
    expect(reply.text).toContain('<b>2. playground</b>')
    expect(reply.text).toContain('<b>2.1</b>　实验会话')
    expect(h.agents).toHaveLength(0)
  })

  it('/use selects an existing numbered session and resumes it', async () => {
    const h = createHarness({}, {
      workspaces: [{ path: '/telegram', title: 'telegram', sessionIds: ['s-a', 's-b'] }],
      sessions: [
        { id: 's-a', cwd: '/telegram', title: '第一段会话' },
        { id: 's-b', cwd: '/telegram', title: '第二段会话', agentPreset: 'coding' },
      ],
    })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use 1 2' })])
    await waitFor(() => h.ctx.agents.resume.mock.calls.length === 1 ? true : undefined, 'session resumed')
    expect(h.ctx.agents.resume.mock.calls[0]?.[0]).toMatchObject({ resumeSessionId: 's-b' })
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '继续' }), update_id: 2 }])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 1 ? true : undefined, 'message forwarded')
  })

  it('/use reuses a Web-live Agent instead of resuming the live Session again', async () => {
    const h = createHarness({}, {
      workspaces: [{ path: '/telegram', title: 'telegram', sessionIds: ['s-live'] }],
      sessions: [{ id: 's-live', cwd: '/telegram', title: 'Web 会话' }],
      liveSessionIds: ['s-live'],
    })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use 1 1' })])
    await waitFor(() => h.sent.some(message => message.text.includes('会话已切换')) ? true : undefined, 'live selection')
    expect(h.ctx.agents.resume).not.toHaveBeenCalled()
    expect(h.ctx.sessionController.selectModel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-live',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }))

    const live = h.ctx.agents.get('s-live') as FakeAgent
    expect(live.handlers.get('user-questions/request')).toHaveLength(1)
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '继续' }), update_id: 2 }])
    await waitFor(() => live.followup.mock.calls.length === 1 ? true : undefined, 'live Agent delivery')
  })

  it('/use keeps bridge-owned Agents live across switches and rebinds without another resume', async () => {
    const h = createHarness({}, {
      workspaces: [{ path: '/telegram', title: 'telegram', sessionIds: ['s-a', 's-b'] }],
      sessions: [
        { id: 's-a', cwd: '/telegram', title: '第一段会话' },
        { id: 's-b', cwd: '/telegram', title: '第二段会话' },
      ],
    })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use 1 1' })])
    await waitFor(() => h.ctx.agents.resume.mock.calls.length === 1 ? true : undefined, 'first resume')
    const first = h.agents[0]!

    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/use 1 2' }), update_id: 2 }])
    await waitFor(() => h.ctx.agents.resume.mock.calls.length === 2 ? true : undefined, 'second resume')
    expect(first.dispose).not.toHaveBeenCalled()
    expect(first.agent.handlers.get('user-questions/request')).toHaveLength(0)

    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/use 1 1' }), update_id: 3 }])
    await waitFor(() => first.agent.handlers.get('user-questions/request')?.length === 1 ? true : undefined, 'first Agent rebound')
    expect(h.ctx.agents.resume).toHaveBeenCalledTimes(2)
    expect(first.dispose).not.toHaveBeenCalled()
  })

  it('every no-argument selector shows the complete current selection', async () => {
    const h = createHarness({ reasoningEffort: 'high' }, {
      workspaces: [{ path: '/telegram', title: 'telegram', sessionIds: ['s-a'] }],
      sessions: [{ id: 's-a', cwd: '/telegram', title: '第一段会话' }],
    })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use 1 1' })])
    await waitFor(() => h.ctx.agents.resume.mock.calls.length === 1 ? true : undefined, 'session resumed')
    await waitFor(() => h.sent.length === 1 ? true : undefined, 'selection reply')
    h.sent.length = 0
    h.client.getUpdates.mockResolvedValueOnce([
      { ...update({ text: '/use' }), update_id: 2 },
      { ...update({ text: '/model' }), update_id: 3 },
      { ...update({ text: '/reasoning' }), update_id: 4 },
    ])
    await waitFor(() => h.sent.length === 3 ? true : undefined, 'selector summaries')
    for (const reply of h.sent) {
      expect(reply.parseMode).toBe('HTML')
      expect(reply.text).toContain('<b>当前选择</b>')
      expect(reply.text).toContain('<b>工作区</b>　telegram')
      expect(reply.text).toContain('└ /telegram')
      expect(reply.text).toContain('<b>会话</b>　第一段会话（s-a）')
      expect(reply.text).toContain('<b>模型</b>　DeepSeek V4 Flash（deepseek-official/deepseek-v4-flash）')
      expect(reply.text).toContain('<b>思考强度</b>　High（high）')
    }
    expect(h.sent[0]?.text).toContain('<b>1. telegram</b>　✅ 当前工作区')
    expect(h.sent[0]?.text).toContain('<b>1.1</b>　第一段会话　✅ 当前会话')
    expect(h.sent[1]?.text).toContain('DeepSeek V4 Flash</b>　✅ 当前')
    expect(h.sent[2]?.text).toContain('High</b>　high　✅ 当前')
  })

  it('/use with session 0 creates and attaches a session to the selected workspace', async () => {
    const h = createHarness({}, { workspaces: [{ path: '/chosen', title: 'chosen' }] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const active = await selectNew(h)
    expect(h.ctx.agents.create.mock.calls[0]?.[0]).toMatchObject({ meta: { cwd: '/chosen' } })
    expect(h.workspaces[0]!.attachSession).toHaveBeenCalledWith(SessionId(active.agent.session.id))
    expect(h.workspaces[0]!.sessionIds.map(String)).toContain(active.agent.session.id)
  })

  it('/use repairs historical Telegram sessions that have a matching workspace cwd', async () => {
    const h = createHarness({}, {
      workspaces: [{ path: '/telegram', title: 'telegram' }],
      sessions: [{ id: 'telegram:7:legacy', cwd: '/telegram', title: '旧会话' }],
    })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use' })])
    const reply = await waitFor(() => h.sent[0], 'catalog reply')
    expect(h.workspaces[0]!.attachSession).toHaveBeenCalledWith(SessionId('telegram:7:legacy'))
    expect(reply.text).toContain('<b>1.1</b>　旧会话')
  })

  it('/clear detaches and deletes the current JSONL session while retaining its workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-telegram-clear-'))
    const logPath = join(directory, 'session.jsonl')
    await writeFile(logPath, '{}\n')
    try {
      const h = createHarness({}, {
        workspaces: [{ path: '/telegram', title: 'telegram', sessionIds: ['telegram:7:old'] }],
        sessions: [{ id: 'telegram:7:old', cwd: '/telegram', location: logPath }],
      })
      h.bridge.start()
      await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
      h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use 1 1' })])
      await waitFor(() => h.ctx.agents.resume.mock.calls.length === 1 ? true : undefined, 'session resumed')
      h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/clear' }), update_id: 2 }])
      await waitFor(() => h.sent.some(message => message.text.includes('已永久删除会话')) ? true : undefined, 'delete reply')
      await expect(access(logPath)).rejects.toThrow()
      expect(h.workspaces[0]!.detachSession).toHaveBeenCalledWith(SessionId('telegram:7:old'))
      expect(h.workspaces[0]!.sessionIds).toHaveLength(0)

      h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '不能发送' }), update_id: 3 }])
      await waitFor(() => h.sent.some(message => message.text.includes('尚未选择会话')) ? true : undefined, 'post-clear selection notice')
      expect(h.ctx.agents.create).not.toHaveBeenCalled()

      h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/new' }), update_id: 4 }])
      await waitFor(() => h.ctx.agents.create.mock.calls.length === 1 ? true : undefined, 'new session in retained workspace')
      expect(h.ctx.agents.create.mock.calls[0]?.[0]).toMatchObject({ meta: { cwd: '/telegram' } })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('/clear refuses to delete a Session whose lifecycle belongs to Web UI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-telegram-borrowed-clear-'))
    const logPath = join(directory, 'session.jsonl')
    await writeFile(logPath, '{}\n')
    try {
      const h = createHarness({}, {
        workspaces: [{ path: '/telegram', title: 'telegram', sessionIds: ['s-live'] }],
        sessions: [{ id: 's-live', cwd: '/telegram', title: 'Web 会话', location: logPath }],
        liveSessionIds: ['s-live'],
      })
      h.bridge.start()
      await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
      h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use 1 1' })])
      await waitFor(() => h.sent.some(message => message.text.includes('会话已切换')) ? true : undefined, 'live selection')
      h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/clear' }), update_id: 2 }])
      await waitFor(
        () => h.sent.some(message => message.text.includes('DSH 其他界面保持运行')) ? true : undefined,
        'borrowed clear rejection',
      )
      await expect(access(logPath)).resolves.toBeUndefined()
      expect(h.workspaces[0]!.detachSession).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('forwards a text message to the chat agent as a user message', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: 'hello' }), update_id: 2 }])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 1 ? true : undefined, 'message forwarded')
    expect(h.agents[0]?.agent.followup).toHaveBeenCalledTimes(1)
    const message = h.agents[0]?.agent.followup.mock.calls[0]?.[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('hello')
  })

  it('steers ordinary concurrent input but queues an explicit /followup', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const active = await selectNew(h)
    active.agent.status = 'running'
    h.client.getUpdates.mockResolvedValueOnce([
      { ...update({ text: '修改一下当前做法' }), update_id: 2 },
      { ...update({ text: '/followup 完成以后再检查测试' }), update_id: 3 },
    ])
    await waitFor(() => active.agent.steer.mock.calls.length === 1 ? true : undefined, 'steering input')
    await waitFor(() => active.agent.followup.mock.calls.length === 1 ? true : undefined, 'queued follow-up')
    expect((active.agent.steer.mock.calls[0]?.[0] as { content: Array<{ text?: string }> }).content[0]?.text)
      .toBe('修改一下当前做法')
    expect((active.agent.followup.mock.calls[0]?.[0] as { content: Array<{ text?: string }> }).content[0]?.text)
      .toBe('完成以后再检查测试')
  })

  it('rejects unsupported Telegram documents without delivering them to DSH', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({
      document: {
        file_id: 'pdf-file',
        file_unique_id: 'pdf-unique',
        file_name: 'notes.pdf',
        mime_type: 'application/pdf',
      },
    }), update_id: 1 }])
    const notice = await waitFor(
      () => h.sent.find(message => message.text.includes('<b>不支持此文件</b>') && message.text.includes('notes.pdf')),
      'unsupported-document notice',
    )
    expect(notice.text).toContain('PNG、JPEG、WebP、GIF')
    expect(h.client.downloadFile).not.toHaveBeenCalled()
    expect(h.agents).toHaveLength(0)
  })

  it('accepts standalone images and treats image/text sequences in either order as ordinary delivery', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dsh-telegram-image-'))
    try {
      const h = createHarness({ model: 'vision' }, {
        workspaces: [{ path: workspacePath, title: 'images' }],
        models: [{
          provider: 'deepseek-official',
          providerName: 'DeepSeek',
          id: 'vision',
          name: 'Vision',
          inputModalities: ['text', 'image'],
        }],
      })
      h.client.downloadFile.mockResolvedValueOnce({
        file: { file_id: 'photo-large', file_unique_id: 'telegram-photo', file_path: 'photos/photo.jpg' },
        data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      })
      h.bridge.start()
      await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
      const active = await selectNew(h)
      active.agent.followup.mockImplementationOnce(() => { active.agent.status = 'running' })
      h.client.getUpdates.mockResolvedValueOnce([
        { ...update({
          messageId: 22,
          photo: [
            { file_id: 'photo-small', file_unique_id: 'small', width: 100, height: 100, file_size: 100 },
            { file_id: 'photo-large', file_unique_id: 'telegram-photo', width: 1000, height: 800, file_size: 400 },
          ],
        }), update_id: 2 },
        { ...update({ messageId: 23, text: '然后处理这条文字' }), update_id: 3 },
      ])
      const outcome = await waitFor(
        () => active.agent.followup.mock.calls.length === 1
          ? 'delivered'
          : h.sent.find(message => message.text.includes('失败'))?.text,
        'image outcome',
      )
      expect(outcome).toBe('delivered')
      await waitFor(() => active.agent.steer.mock.calls.length === 1 ? true : undefined, 'text steered after image')

      expect(h.client.downloadFile).toHaveBeenCalledWith(
        'photo-large',
        h.ctx.attachments.imageLimits.maxImageBytes,
        expect.any(AbortSignal),
      )
      expect(h.ctx.attachments.validateImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/jpeg' }))
      expect(h.ctx.attachments.saveImages).toHaveBeenCalledOnce()
      const content = (active.agent.followup.mock.calls[0]?.[0] as { content: Array<Record<string, unknown>> }).content
      expect(content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('telegram-downloads/') }),
        expect.objectContaining({ type: 'image', attachment: expect.objectContaining({ mediaType: 'image/jpeg' }) }),
      ])
      expect((active.agent.steer.mock.calls[0]?.[0] as { content: Array<{ text?: string }> }).content[0]?.text)
        .toBe('然后处理这条文字')
      const saved = await readdir(join(workspacePath, 'telegram-downloads'))
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatch(/^telegram-photo-22-telegram-photo-22\.jpg$/)

      active.agent.status = 'idle'
      active.agent.followup.mockClear()
      active.agent.steer.mockClear()
      active.agent.followup.mockImplementationOnce(() => { active.agent.status = 'running' })
      h.client.getUpdates.mockResolvedValueOnce([
        { ...update({ messageId: 24, text: '先处理文字' }), update_id: 4 },
        { ...update({
          messageId: 25,
          photo: [{ file_id: 'photo-after-text', file_unique_id: 'after-text', width: 640, height: 480 }],
        }), update_id: 5 },
      ])
      await waitFor(() => active.agent.followup.mock.calls.length === 1 ? true : undefined, 'leading text delivered')
      await waitFor(() => active.agent.steer.mock.calls.length === 1 ? true : undefined, 'image steered after text')
      expect((active.agent.followup.mock.calls[0]?.[0] as { content: Array<{ text?: string }> }).content[0]?.text)
        .toBe('先处理文字')
      const steeredImage = (active.agent.steer.mock.calls[0]?.[0] as { content: Array<Record<string, unknown>> }).content
      expect(steeredImage.some(block => block.type === 'image')).toBe(true)
    } finally {
      await current?.bridge.stop()
      current = undefined
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps Telegram reply text and reply images inside the current user message', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dsh-telegram-reply-'))
    try {
      const h = createHarness({ model: 'vision' }, {
        workspaces: [{ path: workspacePath, title: 'quoted' }],
        models: [{
          provider: 'deepseek-official',
          providerName: 'DeepSeek',
          id: 'vision',
          name: 'Vision',
          inputModalities: ['text', 'image'],
        }],
      })
      h.bridge.start()
      await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
      const active = await selectNew(h)
      h.client.getUpdates.mockResolvedValueOnce([{ ...update({
        messageId: 31,
        text: '按我引用的内容继续',
        reply_to_message: {
          message_id: 30,
          chat: { id: 7, type: 'private' },
          from: { id: 42, username: 'alice' },
          caption: '这是之前那张图',
          photo: [{ file_id: 'quoted-photo', file_unique_id: 'quoted-unique', width: 640, height: 480 }],
          date: 0,
        },
      }), update_id: 2 }])
      await waitFor(() => active.agent.followup.mock.calls.length === 1 ? true : undefined, 'quoted message delivered')
      const content = (active.agent.followup.mock.calls[0]?.[0] as { content: Array<Record<string, unknown>> }).content
      expect(content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('[Telegram 引用消息 #30，来自 @alice；以下仅为被引用内容]'),
      })
      expect(content[0]?.text).toContain('> 这是之前那张图')
      expect(content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Telegram 引用图片已保存到工作区') })
      expect(content[2]).toMatchObject({ type: 'image' })
      expect(content[3]).toMatchObject({ type: 'text', text: '按我引用的内容继续' })
    } finally {
      await current?.bridge.stop()
      current = undefined
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('collects captionless images and text explicitly, then submits the batch as steering while running', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dsh-telegram-collect-'))
    try {
      const h = createHarness({ model: 'vision' }, {
        workspaces: [{ path: workspacePath, title: 'collection' }],
        models: [{
          provider: 'deepseek-official',
          providerName: 'DeepSeek',
          id: 'vision',
          name: 'Vision',
          inputModalities: ['text', 'image'],
        }],
      })
      h.bridge.start()
      await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
      const active = await selectNew(h)
      active.agent.status = 'running'
      h.client.getUpdates.mockResolvedValueOnce([
        { ...update({ messageId: 40, text: '/collect' }), update_id: 2 },
        { ...update({
          messageId: 41,
          photo: [{ file_id: 'collected-photo', file_unique_id: 'collected-unique', width: 320, height: 240 }],
        }), update_id: 3 },
        { ...update({ messageId: 42, text: '一起分析这些内容' }), update_id: 4 },
        { ...update({ messageId: 43, text: '/send' }), update_id: 5 },
      ])
      await waitFor(() => active.agent.steer.mock.calls.length === 1 ? true : undefined, 'collection steered')
      expect(active.agent.followup).not.toHaveBeenCalled()
      expect(h.ctx.attachments.saveImages).toHaveBeenCalledOnce()
      const content = (active.agent.steer.mock.calls[0]?.[0] as { content: Array<Record<string, unknown>> }).content
      expect(content.some(block => block.type === 'image')).toBe(true)
      expect(content.some(block => block.type === 'text' && block.text === '一起分析这些内容')).toBe(true)
    } finally {
      await current?.bridge.stop()
      current = undefined
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('answers fixed-choice DSH questions with Telegram inline buttons and advances through a batch', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const handle = await selectNew(h)
    handle.agent.status = 'running'
    const ask = await installQuestionHandler(h, handle)
    const next = vi.fn(async () => ({ answers: [] }))
    const answerPromise = ask({
      questions: [
        {
          id: 'confirm',
          header: '确认操作',
          question: '要继续吗？',
          detail: '这会执行下一步。',
          options: [{ label: '继续' }, { label: '停止' }],
        },
        { id: 'reason', question: '还有什么要补充？' },
      ],
    }, next)

    const firstPrompt = await waitFor(() => h.sent[0], 'first question')
    expect(firstPrompt.text).toContain('确认操作')
    expect(firstPrompt.text).toContain('这会执行下一步。')
    const firstKeyboard = inlineKeyboard(firstPrompt)
    const selectContinue = firstKeyboard.inline_keyboard[0]?.[0]?.callback_data
    expect(selectContinue).toBeTypeOf('string')
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate(selectContinue!, 2, firstPrompt.messageId)])

    const secondPrompt = await waitFor(
      () => h.sent.find(message => message.text.includes('还有什么要补充？')),
      'second question',
    )
    expect(secondPrompt.replyMarkup).toMatchObject({ force_reply: true })
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '没有了' }), update_id: 3 }])

    await expect(answerPromise).resolves.toEqual({
      answers: [
        { id: 'confirm', selected: ['继续'] },
        { id: 'reason', selected: [], custom: '没有了' },
      ],
    })
    expect(next).not.toHaveBeenCalled()
    expect(handle.agent.followup).not.toHaveBeenCalled()
    expect(h.client.answerCallbackQuery).toHaveBeenCalledWith(
      'callback-2',
      '已选择：继续',
      undefined,
      expect.any(AbortSignal),
    )
    expect(h.client.editMessageReplyMarkup).toHaveBeenCalled()
  })

  it('supports multi-select plus a custom Telegram answer without forwarding it as a new turn', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const handle = await selectNew(h)
    handle.agent.status = 'running'
    const ask = await installQuestionHandler(h, handle)
    const answerPromise = ask({
      questions: [{
        id: 'features',
        question: '选择功能',
        options: [{ label: '按钮' }, { label: '回复框' }],
        multiSelect: true,
      }],
    }, async () => ({ answers: [] }))
    const prompt = await waitFor(() => h.sent[0], 'multi-select question')
    const keyboard = inlineKeyboard(prompt)
    const firstOption = keyboard.inline_keyboard[0]?.[0]?.callback_data
    const custom = keyboard.inline_keyboard.flat().find(button => button.text.includes('自定义'))?.callback_data
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate(firstOption!, 2, prompt.messageId)])
    await waitFor(() => h.client.editMessageReplyMarkup.mock.calls.length > 0 ? true : undefined, 'checked keyboard')
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate(custom!, 3, prompt.messageId)])
    const customPrompt = await waitFor(
      () => h.sent.find(message => message.text.includes('请输入自定义回答')),
      'custom answer prompt',
    )
    expect(customPrompt.replyMarkup).toMatchObject({ force_reply: true })
    h.client.getUpdates.mockResolvedValueOnce([{
      ...update({ text: '再加超时处理', messageId: 900 }),
      update_id: 4,
    }])

    await expect(answerPromise).resolves.toEqual({
      answers: [{ id: 'features', selected: ['按钮'], custom: '再加超时处理' }],
    })
    expect(handle.agent.followup).not.toHaveBeenCalled()
    const refreshed = h.client.editMessageReplyMarkup.mock.calls[0]?.[2] as {
      inline_keyboard: Array<Array<{ text: string }>>
    }
    expect(refreshed.inline_keyboard[0]?.[0]?.text).toContain('✓')

    h.emit(handle.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '最终结果' }] } },
    } as SessionEvent)
    h.emit(handle.agent.session.id, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    const finalMessage = await waitFor(
      () => h.sent.find(message => message.text === '最终结果'),
      'final answer',
    )
    await waitFor(() => h.client.deleteMessages.mock.calls[0] ? true : undefined, 'question cleanup')
    const deleted = (h.client.deleteMessages.mock.calls[0]?.[1] as number[]) ?? []
    expect(deleted).toEqual(expect.arrayContaining([prompt.messageId, customPrompt.messageId, 900]))
    expect(deleted).not.toContain(finalMessage.messageId)
  })

  it('rejects a pending DSH question with ASK_ABORTED when its request signal aborts', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const handle = await selectNew(h)
    handle.agent.status = 'running'
    const ask = await installQuestionHandler(h, handle)
    const controller = new AbortController()
    const answerPromise = ask({
      questions: [{ id: 'confirm', question: '继续？', options: [{ label: '是' }, { label: '否' }] }],
      signal: controller.signal,
    }, async () => ({ answers: [] }))
    await waitFor(() => h.sent[0], 'abortable question')
    controller.abort()
    await expect(answerPromise).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    await waitFor(
      () => h.client.editMessageReplyMarkup.mock.calls.some(call => call[2] === undefined) ? true : undefined,
      'keyboard removal',
    )
  })

  it('handles contextual /skip and /cancel commands inside a pending question', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const handle = await selectNew(h)
    handle.agent.status = 'running'
    const ask = await installQuestionHandler(h, handle)

    const skipped = ask({ questions: [{ id: 'optional', question: '可选问题' }] }, async () => ({ answers: [] }))
    await waitFor(() => h.sent[0], 'skippable question')
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/skip' }), update_id: 2 }])
    await expect(skipped).resolves.toEqual({ answers: [{ id: 'optional', selected: [] }] })

    h.sent.length = 0
    const cancelled = ask({
      questions: [{ id: 'confirm', question: '确认问题', options: [{ label: '继续' }] }],
    }, async () => ({ answers: [] }))
    await waitFor(() => h.sent[0], 'cancellable question')
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/cancel' }), update_id: 3 }])
    await expect(cancelled).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    await waitFor(
      () => h.sent.some(message => message.text.includes('已取消提问')) ? true : undefined,
      'cancellation reply',
    )
    expect(handle.agent.followup).not.toHaveBeenCalled()
  })

  it('mounts the configured preset and installs provider/model/reasoning selection', async () => {
    const h = createHarness({
      preset: 'standard',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/use 1 0' })]).mockResolvedValue([])
    h.bridge.start()
    const createOptions = await waitFor(
      () => h.ctx.agents.create.mock.calls[0]?.[0] as {
        meta: Record<string, unknown>
        signal: AbortSignal
        setup: (agentCtx: Context) => Promise<void>
      } | undefined,
      'agent creation options',
    )
    expect(createOptions.meta).toMatchObject({ agentPreset: 'standard' })
    expect(createOptions.signal).toBeInstanceOf(AbortSignal)

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const agentCtx = {
      agent: {},
      systemPrompt: { context: vi.fn() },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler)
        return () => {}
      }),
    } as unknown as Context
    await createOptions.setup(agentCtx)
    expect(h.presetMount).toHaveBeenCalledWith(agentCtx, 'standard')
    const boundAgentCtx = h.agents[0]?.agent.ctx as unknown as {
      systemPrompt: { context: Mock }
    }
    expect(boundAgentCtx.systemPrompt.context).toHaveBeenCalledWith(expect.objectContaining({
      name: 'telegram:channel',
      text: expect.stringContaining('Telegram bot'),
    }))

    const assemble = handlers.get('system-prompt/assemble')
    const request = handlers.get('agent/request')
    expect(assemble).toBeDefined()
    expect(request).toBeDefined()
    const assembly = await assemble?.({}, {}, async () => ({ variables: {} })) as { variables: Record<string, unknown> }
    expect(assembly.variables).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const selected = await request?.({}, async () => ({
      provider: 'inherited',
      model: 'inherited',
      reasoningEffort: 'off',
    })) as Record<string, unknown>
    expect(selected).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
  })

  it('advances the polling offset and reuses the chat agent', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    h.client.getUpdates.mockResolvedValueOnce([
      { ...update({ text: 'one' }), update_id: 2 },
      { update_id: 3, message: { message_id: 2, chat: { id: 7, type: 'private' }, from: { id: 42 }, text: 'two', date: 0 } },
    ])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 2 ? true : undefined, 'messages forwarded')
    expect(h.agents[0]?.agent.followup).toHaveBeenCalledTimes(2)
    await waitFor(() => h.polls.some(offset => offset === 4) ? true : undefined, 'offset advanced')
  })

  it('denies unauthorized users with a notice', async () => {
    const h = createHarness({ allowAllUsers: false, allowedUserIds: [1] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello', fromId: 42 })])
    await waitFor(() => h.sent.length > 0 ? true : undefined, 'denial sent')
    expect(h.sent[0]).toMatchObject({ chatId: 7, text: '⛔ <b>访问被拒绝</b>', parseMode: 'HTML' })
    expect(h.agents.length).toBe(0)
  })

  it('blocks ordinary text before a session is selected, even for an allowed user', async () => {
    const h = createHarness({ allowAllUsers: true })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hi', fromId: 99 })])
    await waitFor(() => h.sent.some(message => message.text.includes('尚未选择会话')) ? true : undefined, 'selection notice')
    expect(h.agents).toHaveLength(0)
  })

  it('ignores updates without a message or text', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([
      { update_id: 1 },
      { update_id: 2, message: { message_id: 2, chat: { id: 7, type: 'private' }, date: 0 } },
      { update_id: 3, message: { message_id: 3, chat: { id: 7, type: 'private' }, from: { id: 42 }, text: '/help', date: 0 } },
    ])
    // The command proves the batch was consumed; the no-message/no-text updates are ignored.
    await waitFor(() => h.sent.some(message => message.text.includes('/use')) ? true : undefined, 'command update processed')
    await settle()
    expect(h.agents.length).toBe(0)
  })

  it('ignores group messages because group mention and topic semantics are unsupported', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const privateUpdate = update({ text: 'do not forward this' })
    const groupUpdate: TelegramUpdate = {
      ...privateUpdate,
      message: { ...privateUpdate.message!, chat: { id: -1007, type: 'supergroup' } },
    }
    h.client.getUpdates.mockResolvedValueOnce([groupUpdate])
    await settle()
    expect(h.agents.length).toBe(0)
    expect(h.sent.length).toBe(0)
  })

  it('/start sends one preset in-character online reply without selecting a session', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/start' })])
    const reply = await waitFor(() => h.sent[0], 'online reply')
    expect(reply.text).toMatch(/我在|夜还很长|茶也还热着|魔女没有离开|久远寺邸|童话还没有醒来/)
    expect(h.agents).toHaveLength(0)
  })

  it('/new rotates the Telegram binding without disposing the previous Agent', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    const first = h.agents[0]!
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/new' }), update_id: 2 }])
    await waitFor(() => h.agents.length === 2 ? true : undefined, 'second agent')
    expect(first.dispose).not.toHaveBeenCalled()
    // Old-session events no longer deliver.
    h.emit(first.agent.session.id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale' }] } } } as SessionEvent)
    await settle()
    expect(h.sent.some(s => s.text === 'stale')).toBe(false)
  })

  it('/clear does not create a session when nothing is selected', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/clear' })])
    await waitFor(() => h.sent.some(message => message.text.includes('没有可删除')) ? true : undefined, 'empty clear reply')
    expect(h.agents).toHaveLength(0)
  })

  it('/help lists the commands', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/help' })])
    const reply = await waitFor(() => h.sent.find(s => s.text.includes('/model')), 'help sent')
    expect(reply.text).toContain('/use')
    expect(reply.text).toContain('/reasoning')
    expect(reply.text).toContain('/start')
    expect(reply.text).not.toContain('/list')
  })

  it('accepts Telegram command suffixes addressed to the bot', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/help@my_bot' })])
    await waitFor(() => h.sent.some(s => s.text.includes('/model')) ? true : undefined, 'help sent')
  })

  it('/model lists numbered choices and applies the selected route to a new session', async () => {
    const h = createHarness()
    h.client.getUpdates
      .mockResolvedValueOnce([
        update({ text: '/model' }),
        { ...update({ text: '/model 2' }), update_id: 2 },
        { ...update({ text: '/use 1 0' }), update_id: 3 },
      ])
      .mockResolvedValue([])
    h.bridge.start()
    await waitFor(() => h.ctx.agents.create.mock.calls.length === 1 ? true : undefined, 'session created with selected model')
    expect(h.sent[0]?.text).toContain('<b>1. DeepSeek / DeepSeek V4 Flash</b>　✅ 当前')
    expect(h.sent[0]?.text).toContain('<b>2. DeepSeek / DeepSeek V4 Pro</b>')
    expect(h.sent[1]?.text).toContain('<b>模型已切换</b>')
    expect(h.sent[1]?.text).toContain('DeepSeek / DeepSeek V4 Pro')
    expect(h.ctx.llm.resolveCallConfig).toHaveBeenCalledWith(
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      expect.any(AbortSignal),
    )
    expect(h.ctx.agents.create.mock.calls[0]?.[0]).toMatchObject({
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })
  })

  it('/model resets an explicit reasoning override to the selected model default', async () => {
    const h = createHarness({ reasoningEffort: 'high' })
    h.client.getUpdates
      .mockResolvedValueOnce([
        update({ text: '/model 2' }),
        { ...update({ text: '/status' }), update_id: 2 },
      ])
      .mockResolvedValue([])
    h.bridge.start()
    await waitFor(() => h.sent.length === 2 ? true : undefined, 'model and status replies')
    expect(h.sent[0]?.text).toContain('思考强度已恢复为该模型默认值')
    expect(h.sent[1]?.text).toContain('<b>模型</b>　DeepSeek V4 Pro（deepseek-official/deepseek-v4-pro）')
    expect(h.sent[1]?.text).toContain('<b>思考强度</b>　模型默认：High（high）')
  })

  it('applies model and reasoning switches to the next task in an existing session', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    const createOptions = h.ctx.agents.create.mock.calls[0]?.[0] as {
      setup: (agentCtx: Context) => Promise<void>
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const agentCtx = {
      agent: {},
      systemPrompt: { context: vi.fn() },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler)
        return () => {}
      }),
    } as unknown as Context
    await createOptions.setup(agentCtx)

    h.client.getUpdates.mockResolvedValueOnce([
      { ...update({ text: '/model 2' }), update_id: 2 },
      { ...update({ text: '/reasoning 3' }), update_id: 3 },
    ])
    await waitFor(() => h.sent.length === 2 ? true : undefined, 'selection replies')

    const assemble = handlers.get('system-prompt/assemble')
    const request = handlers.get('agent/request')
    const assembly = await assemble?.({}, {}, async () => ({ variables: {} })) as { variables: Record<string, unknown> }
    const selected = await request?.({}, async () => ({
      provider: 'inherited',
      model: 'inherited',
      reasoningEffort: 'off',
    })) as Record<string, unknown>
    expect(assembly.variables).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(selected).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
    })
  })

  it('/reasoning lists the selected model capabilities and stores a numbered override', async () => {
    const h = createHarness({ reasoningEffort: 'high' })
    h.client.getUpdates
      .mockResolvedValueOnce([
        update({ text: '/reasoning' }),
        { ...update({ text: '/reasoning 3' }), update_id: 2 },
        { ...update({ text: '/status' }), update_id: 3 },
        { ...update({ text: '/reasoning invalid' }), update_id: 4 },
      ])
      .mockResolvedValue([])
    h.bridge.start()
    await waitFor(() => h.sent.length === 4 ? true : undefined, 'reasoning replies')
    expect(h.sent[0]?.text).toContain('<b>1. 模型默认：High</b>')
    expect(h.sent[0]?.text).toContain('<b>3. Low</b>　low')
    expect(h.sent[0]?.text).toContain('<b>4. High</b>　high　✅ 当前')
    expect(h.sent[1]?.text).toContain('<b>思考强度已切换</b>')
    expect(h.sent[1]?.text).toContain('Low（low）')
    expect(h.sent[2]?.text).toContain('<b>思考强度</b>　Low（low）')
    expect(h.sent[3]?.text).toContain('切换思考强度失败')
    expect(h.ctx.llm.resolveCallConfig).toHaveBeenCalledWith(
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
      expect.any(AbortSignal),
    )
    expect(h.ctx.agents.create).not.toHaveBeenCalled()
  })

  it('/reasoning accepts adapter-defined effort ids instead of a hard-coded list', async () => {
    const h = createHarness({}, {
      models: [{
        provider: 'deepseek-official',
        providerName: 'DeepSeek',
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        efforts: [{ id: 'balanced', name: 'Balanced' }, { id: 'intense', name: 'Intense' }],
        defaultEffort: 'balanced',
      }],
    })
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/reasoning intense' })]).mockResolvedValue([])
    h.bridge.start()
    const reply = await waitFor(() => h.sent[0], 'custom reasoning reply')
    expect(reply.text).toContain('Intense（intense）')
    expect(h.ctx.llm.resolveCallConfig).toHaveBeenCalledWith(
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'intense' },
      expect.any(AbortSignal),
    )
  })

  it('does not change model or reasoning while the current agent is running', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const active = await selectNew(h)
    active.agent.status = 'running'
    h.ctx.llm.resolveCallConfig.mockClear()
    h.client.getUpdates.mockResolvedValueOnce([
      { ...update({ text: '/model 2' }), update_id: 2 },
      { ...update({ text: '/reasoning 3' }), update_id: 3 },
    ])
    await waitFor(() => h.sent.length === 2 ? true : undefined, 'running mutation replies')
    expect(h.sent[0]?.text).toContain('<b>任务仍在运行</b>')
    expect(h.sent[1]?.text).toContain('<b>任务仍在运行</b>')
    expect(h.ctx.llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('/status reports an unselected startup state without creating an agent', async () => {
    const h = createHarness()
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/status' })]).mockResolvedValue([])
    h.bridge.start()
    const reply = await waitFor(() => h.sent[0], 'status reply')
    expect(reply.text).toContain('<b>工作区</b>　未选择')
    expect(reply.text).toContain('<b>会话</b>　未选择')
    expect(reply.text).toContain('<b>模型</b>　DeepSeek V4 Flash（deepseek-official/deepseek-v4-flash）')
    expect(reply.text).toContain('<b>思考强度</b>　模型默认：High（high）')
    expect(h.ctx.agents.create).not.toHaveBeenCalled()
  })

  it('/stop does not create an agent when the chat has no session', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/stop' })])
    await waitFor(() => h.sent.length > 0 ? true : undefined, 'idle notice')
    expect(h.agents.length).toBe(0)
  })

  it('replies to unknown commands', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/bogus' })])
    await waitFor(() => h.sent.some(s => s.text.includes('未知命令')) ? true : undefined, 'unknown reply')
  })

  it('delivers assistant text as split HTML messages', async () => {
    const h = createHarness({ maxMessageLength: 12 })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    const long = 'a'.repeat(30)
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: long }] } },
    } as SessionEvent)
    // The final answer is delivered on turn/end; a lone assistant/message
    // only records the text (the progress-message design).
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    await waitFor(() => h.sent.length >= 3 ? true : undefined, 'chunks delivered')
    expect(h.sent.map(s => s.text).join('')).toBe(long)
    expect(h.sent.every(s => s.parseMode === 'HTML')).toBe(true)
  })

  it('ignores assistant messages without text blocks', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool', id: 't' }] } },
    } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(0)
  })

  it('falls back to plain text when HTML delivery is rejected', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    h.client.sendMessage
      .mockRejectedValueOnce(new Error('can\'t parse entities'))
      .mockResolvedValue({ message_id: 1, chat: { id: 7, type: 'private' }, date: 0 })
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '<b>hi</b>' }] } },
    } as SessionEvent)
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    await waitFor(() => h.client.sendMessage.mock.calls.length >= 2 ? true : undefined, 'fallback sent')
    const first = h.client.sendMessage.mock.calls[0] as [number, string, 'HTML' | undefined, AbortSignal]
    const second = h.client.sendMessage.mock.calls[1] as [number, string, 'HTML' | undefined, AbortSignal]
    expect(first.slice(0, 3)).toEqual([7, '&lt;b&gt;hi&lt;/b&gt;', 'HTML'])
    expect(second.slice(0, 3)).toEqual([7, '<b>hi</b>', undefined])
  })

  it('does not retry a transport failure as plain text and risk a duplicate', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    h.client.sendMessage.mockRejectedValue(new Error('network down'))
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    } as SessionEvent)
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    await waitFor(() => h.ctx.logger.error.mock.calls.length > 0 ? true : undefined, 'error logged')
    expect(h.client.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('logs a plain-text delivery failure from the command path', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.sendMessage.mockRejectedValue(new Error('down'))
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/help' })])
    await waitFor(() => h.ctx.logger.error.mock.calls.length > 0 ? true : undefined, 'delivery error logged')
    expect(h.ctx.logger.error.mock.calls[0]?.[0]).toBe('[telegram] delivery failed: %s')
  })

  it('logs a failed typing action without breaking the turn', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.sendChatAction.mockRejectedValue(new Error('action down'))
    await selectNew(h)
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/start', data: {} } as SessionEvent)
    await waitFor(() => h.ctx.logger.warn.mock.calls.length > 0 ? true : undefined, 'action warning logged')
    expect(h.ctx.logger.warn.mock.calls[0]?.[0]).toBe('[telegram] chat action %s failed: %s')
  })

  it('sends the typing action on turn start', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/start', data: {} } as SessionEvent)
    await waitFor(() => h.actions.length === 1 ? true : undefined, 'typing sent')
    expect(h.actions[0]).toEqual({ chatId: 7, action: 'typing' })
  })

  it('sends every assistant step separately, then deletes prior steps and keeps the final step', async () => {
    const h = createHarness({ maxMessageLength: 16 })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    const sessionId = h.agents[0]!.agent.session.id
    h.emit(sessionId, { type: 'turn/start', data: { turn: 1 } } as SessionEvent)
    h.emit(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'first' }] } },
    } as SessionEvent)
    h.emit(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'x'.repeat(40) }] } },
    } as SessionEvent)
    await waitFor(() => h.sent.length === 4 ? true : undefined, 'separate intermediate outputs')
    const [first, ...finalChunks] = h.sent
    expect(first?.text).toBe('first')
    expect(finalChunks.map(message => message.text).join('')).toBe('x'.repeat(40))
    expect(h.sent.every(message => message.text.length <= 16)).toBe(true)
    expect(h.client.editMessageText).not.toHaveBeenCalled()

    h.emit(sessionId, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    await waitFor(() => h.client.deleteMessages.mock.calls[0] ? true : undefined, 'intermediate cleanup')
    const deleted = h.client.deleteMessages.mock.calls[0]?.[1] as number[]
    expect(deleted).toContain(first!.messageId)
    for (const chunk of finalChunks) expect(deleted).not.toContain(chunk.messageId)
  })

  it('ignores non-delivery event kinds on known sessions', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(0)
    expect(h.actions.length).toBe(0)
  })

  it('ignores session events from foreign sessions', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.emit('other-session', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(0)
    expect(h.actions.length).toBe(0)
  })

  it('backs off with a warning when polling fails and retries', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockRejectedValueOnce('boom')
    await waitFor(() => h.ctx.logger.warn.mock.calls.length > 0 ? true : undefined, 'warning logged')
    await waitFor(() => h.polls.length >= 2 ? true : undefined, 'retry poll')
    expect(h.sleeps).toContain(1000)
  })

  it('reports a selected-chat delivery failure to the Telegram user and keeps polling', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    const active = await selectNew(h)
    active.agent.followup.mockImplementationOnce(() => { throw new Error('no adapter') })
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: 'go' }), update_id: 2 }])
    await waitFor(
      () => h.sent.find(message => message.text.includes('<b>消息处理失败</b>') && message.text.includes('no adapter')),
      'delivery failure notice',
    )
    expect(h.ctx.logger.error).not.toHaveBeenCalled()
  })

  it('stop disposes agents, unregisters the listener, and ends polling', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    await h.bridge.stop()
    const pollCount = h.polls.length
    await settle()
    expect(h.agents[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(h.polls.length).toBe(pollCount)
    expect(h.ctx.on.mock.results[0]?.value).toBeTypeOf('function')
  })

  it('aborts and awaits an in-flight long poll during stop', async () => {
    const h = createHarness()
    let signal: AbortSignal | undefined
    h.client.getUpdates.mockImplementationOnce(async (_offset?: number, requestSignal?: AbortSignal) => {
      signal = requestSignal
      await new Promise<void>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return []
    })
    h.bridge.start()
    await waitFor(() => signal, 'poll abort signal')
    await h.bridge.stop()
    expect(signal?.aborted).toBe(true)
    expect(h.ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('start is idempotent', async () => {
    const h = createHarness()
    h.bridge.start()
    h.bridge.start()
    expect(h.ctx.on).toHaveBeenCalledTimes(1)
    await h.bridge.stop()
  })

  it('runs the production default sleep cadence with a client seam', async () => {
    const client = {
      getMe: vi.fn(async () => ({ id: 1, is_bot: true })),
      getUpdates: vi.fn(async () => [] as TelegramUpdate[]),
      sendMessage: vi.fn(async () => ({ message_id: 1, chat: { id: 7, type: 'private' }, date: 0 })),
      sendChatAction: vi.fn(async () => true),
      setMyCommands: vi.fn(async () => true),
      editMessageText: vi.fn(async (chatId: number, messageId: number) => ({
        message_id: messageId,
        chat: { id: chatId, type: 'private' },
        date: 0,
      })),
      editMessageReplyMarkup: vi.fn(async (chatId: number, messageId: number) => ({
        message_id: messageId,
        chat: { id: chatId, type: 'private' },
        date: 0,
      })),
      answerCallbackQuery: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
      deleteMessages: vi.fn(async () => true),
      downloadFile: vi.fn(async (): Promise<TelegramDownloadedFile> => ({
        file: { file_id: 'f', file_unique_id: 'u', file_path: 'photos/f' },
        data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      })),
    }
    const ctx = {
      on: () => () => {},
      agents: { create: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() },
    }
    const bridge = new TelegramBridge(ctx as unknown as Context, { token: 't:ok', client })
    bridge.start()
    await new Promise(resolve => setTimeout(resolve, 120))
    await bridge.stop()
  })

  it('constructs the production client with and without an explicit polling timeout', () => {
    const withTimeout = new TelegramBridge({} as unknown as Context, { token: 't:ok', pollingTimeoutSec: 5 })
    const defaulted = new TelegramBridge({} as unknown as Context, { token: 't:ok' })
    expect(withTimeout).toBeInstanceOf(TelegramBridge)
    expect(defaulted).toBeInstanceOf(TelegramBridge)
  })

  it('rejects message limits outside Telegram\'s supported range', () => {
    const ctx = {} as unknown as Context
    expect(() => new TelegramBridge(ctx, { token: 't:ok', maxMessageLength: 0 })).toThrow('maxMessageLength')
    expect(() => new TelegramBridge(ctx, { token: 't:ok', maxMessageLength: 4097 })).toThrow('maxMessageLength')
  })

  it('stores the selected existing workspace path in new session metadata', async () => {
    const h = createHarness({}, { workspaces: [{ path: '/chosen/workspace', title: 'chosen' }] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await selectNew(h)
    const options = await waitFor(
      () => h.ctx.agents.create.mock.calls[0]?.[0] as { meta: { cwd: string } } | undefined,
      'agent cwd',
    )
    expect(options.meta.cwd).toBe('/chosen/workspace')
  })
})
