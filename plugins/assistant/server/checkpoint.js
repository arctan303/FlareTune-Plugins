import { effectiveAiBaseUrl, sourceFromProvider, legacyProtocol } from "@flaretune/plugin-service/ai-gateway/shared/aiProtocols.js";

// Private checkpoints stay on the turn's user row. No schema change or public
// native reasoning payload is needed, and image references remain untouched.
export async function readAssistantCheckpoint(db, accountId, turnId) {
  const row = await db.prepare(`SELECT extra_json FROM music_chat_thread_messages
    WHERE account_id = ? AND turn_id = ? AND role = 'user'`).bind(accountId, turnId).first();
  try { return JSON.parse(row?.extra_json || '{}').checkpoint || {}; } catch { return {}; }
}

export function createAssistantCheckpoint(db, accountId, turnId, revision, now = Date.now) {
  let trace = {};
  let queue = Promise.resolve();
  let closed = false;
  let closing;
  let dirty = false;
  let lastWrite = 0;
  const flush = () => {
    if (closed) return queue;
    const snapshot = dirty ? JSON.stringify(trace) : null;
    dirty = false;
    const timestamp = now();
    lastWrite = timestamp;
    const heartbeatStatement = db.prepare(`UPDATE music_chat_turns SET updated_at = ?
      WHERE id = ? AND account_id = ? AND reserved_revision = ? AND status = 'running'`)
      .bind(timestamp, turnId, accountId, revision);
    queue = queue.then(async () => snapshot === null ? [await heartbeatStatement.run()] : db.batch([
      db.prepare(`UPDATE music_chat_thread_messages
        SET extra_json = json_set(COALESCE(extra_json, '{}'), '$.checkpoint', json(?))
        WHERE account_id = ? AND turn_id = ? AND role = 'user'
          AND EXISTS (SELECT 1 FROM music_chat_turns WHERE id = ? AND account_id = ?
            AND reserved_revision = ? AND status = 'running')`)
        .bind(snapshot, accountId, turnId, turnId, accountId, revision),
      heartbeatStatement,
    ])).then(results => {
      const result = results.at(-1);
      if (Number(result?.meta?.changes ?? result?.changes) !== 1) throw new Error('AI_STREAM_CANCELLED');
    });
    return queue;
  };
  const heartbeat = setInterval(() => { void flush().catch(() => {}); }, 15000);
  return {
    update(next) {
      if (closed) return;
      trace = { ...trace, ...next }; dirty = true;
      if (now() - lastWrite >= 5000) void flush().catch(() => {});
    },
    flush,
    close() {
      if (closing) return closing;
      clearInterval(heartbeat);
      closing = dirty ? flush() : queue; closed = true;
      return closing;
    },
  };
}

export function assistantContextIdentity(config, env = {}) {
  if (typeof config.gatewayIdentity === 'string') return config.gatewayIdentity;
  const source = config.source || sourceFromProvider(config.provider);
  const protocol = config.protocol || legacyProtocol(config.provider);
  const prefix = { deepseek: 'DEEPSEEK', openai: 'OPENAI', gemini: 'GEMINI', anthropic: 'ANTHROPIC', custom: 'OPENAI' }[source];
  const baseUrl = effectiveAiBaseUrl(source, env.AI_PROFILE_BASE_URL || env[`${prefix}_BASE_URL`] || '', protocol);
  return JSON.stringify({ profile: config.profileId || config.provider, revision: config.profileRevision ?? null,
    source, protocol, model: config.model, baseUrl });
}

export function assistantOperationKey(name, args) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  let operation = args;
  if (name === 'manage_playlist') {
    const { expected_revision: ignoredRevision, ...intent } = args;
    operation = intent.action === 'create' ? { action: 'create', name: intent.name?.trim(), description: intent.description?.trim() || '' }
      : { ...intent, playlist_id: intent.playlist_id?.trim() };
  }
  return `${name}:${JSON.stringify(canonical(operation))}`;
}

// Guard in the same D1 transaction as the write, including writes reached after
// asynchronous tool reads. A rejected guard rolls back the whole batch.
export function guardedAssistantToolDb(db, accountId, turnId, revision) {
  const raw = Symbol('assistantStatement');
  const guard = () => db.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM music_chat_turns active JOIN music_chat_threads t ON t.account_id = active.account_id
    WHERE active.id = ? AND active.account_id = ? AND active.status = 'running'
      AND active.reserved_revision = ? AND t.revision = ?
  ) THEN 1 ELSE json('assistant_turn_cancelled') END`).bind(turnId, accountId, revision, revision);
  return {
    prepare(sql) {
      let statement = db.prepare(sql);
      const wrapper = { get [raw]() { return statement; },
        bind(...values) { statement = statement.bind(...values); return wrapper; },
        first: (...args) => statement.first(...args),
        all: (...args) => statement.all(...args),
        run: async () => (await db.batch([guard(), statement]))[1],
      };
      return wrapper;
    },
    batch: async statements => (await db.batch([guard(), ...statements.map(statement => statement[raw] || statement)])).slice(1),
  };
}

// The provider can replay only complete native output. Unfinished calls get a
// synthetic *unknown outcome*, never execution or a fabricated success/signature.
export function completeSavedToolContext(messages) {
  const output = [];
  for (const message of messages) {
    output.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const index = messages.indexOf(message);
    for (const call of message.tool_calls) {
      if (!messages.slice(index + 1).some(item => item.role === 'tool' && item.tool_call_id === call.id)) {
        output.push({ role: 'tool', tool_call_id: call.id, name: call.function.name,
          content: '系统中断：该调用的执行结果未知。先查询真实状态；不要重复写操作或声称成功。' });
      }
    }
  }
  return output;
}
