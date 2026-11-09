const MAX_MEMORIES = 30;
const rows = (result) => result?.results || [];
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export class MemoryError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function validContent(value) {
  if (typeof value !== 'string') throw new MemoryError('invalid_memory');
  const content = value.trim().replace(/\s+/gu, ' ');
  if (!content || content.length > 240 || /[\u0000-\u001f\u007f]/u.test(content)) {
    throw new MemoryError('invalid_memory');
  }
  // Memory is user information, never a store for credentials.
  if (/(?:密码|验证码|密钥|口令|私钥|api[\s_-]*key|access[\s_-]*token|bearer[\s_-]*token)\s*(?:[:：=]|是|为|是：|为：|\s)\s*\S{4,}/iu.test(content)
    || /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u.test(content)
    || /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(content)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) {
    throw new MemoryError('credential_not_allowed');
  }
  return content;
}

const dto = (row) => ({ id: row.id, content: row.content, source: row.source,
  createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });

export async function memoryEnabled(db, accountId) {
  const setting = await db.prepare(`SELECT enabled FROM assistant_memory_settings WHERE account_id = ?`)
    .bind(accountId).first();
  return setting?.enabled === 1;
}

export async function readAssistantMemories(db, accountId, { forAssistant = false } = {}) {
  const result = await db.batch([
    db.prepare(`SELECT enabled FROM assistant_memory_settings WHERE account_id=?`).bind(accountId),
    db.prepare(`SELECT id, content, source, created_at, updated_at
    FROM assistant_memories WHERE account_id = ?
    ${forAssistant ? 'AND EXISTS (SELECT 1 FROM assistant_memory_settings s WHERE s.account_id = ? AND s.enabled = 1)' : ''}
    ORDER BY updated_at DESC, id LIMIT ?`)
    .bind(...(forAssistant ? [accountId, accountId, MAX_MEMORIES] : [accountId, MAX_MEMORIES])),
  ]);
  return { enabled: rows(result[0])[0]?.enabled === 1, memories: rows(result[1]).map(dto) };
}

export async function setAssistantMemoryEnabled(db, accountId, enabled, now = Date.now()) {
  if (typeof enabled !== 'boolean') throw new MemoryError('invalid_input');
  await db.prepare(`INSERT INTO assistant_memory_settings (account_id, enabled, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
    enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .bind(accountId, enabled ? 1 : 0, now).run();
  return { enabled };
}

export async function saveAssistantMemory(db, accountId, { id, content, source = 'user_edited',
  actor = 'user', now = Date.now() }) {
  const clean = validContent(content);
  if (!['stated', 'inferred', 'user_edited'].includes(source)) throw new MemoryError('invalid_source');
  if (actor === 'assistant' && !['stated', 'inferred'].includes(source)) throw new MemoryError('invalid_source');
  if (id !== undefined) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new MemoryError('invalid_memory_id');
    const result = await db.prepare(`UPDATE assistant_memories SET content = ?, source = ?, updated_at = ?
      WHERE id = ? AND account_id = ? ${actor === 'assistant' ? `AND source != 'user_edited'
      AND EXISTS (SELECT 1 FROM assistant_memory_settings s WHERE s.account_id = ? AND s.enabled = 1)` : ''}
      RETURNING id,content,source,created_at,updated_at`)
      .bind(...(actor === 'assistant' ? [clean, source, now, id, accountId, accountId]
        : [clean, 'user_edited', now, id, accountId])).all();
    const saved = rows(result)[0];
    if (!saved) {
      if (actor === 'assistant' && !await memoryEnabled(db, accountId)) throw new MemoryError('memory_disabled', 403);
      throw new MemoryError('memory_not_found', 404);
    }
    return { memory: dto(saved), action: 'updated' };
  }
  const newId = crypto.randomUUID();
  const result = await db.batch([
    db.prepare(`SELECT COALESCE((SELECT enabled FROM assistant_memory_settings WHERE account_id=?),0) AS enabled`)
      .bind(accountId),
    db.prepare(`INSERT INTO assistant_memories
    (id, account_id, content, source, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE
      (SELECT COUNT(*) FROM assistant_memories WHERE account_id = ?) < ?
      AND NOT EXISTS(SELECT 1 FROM assistant_memories WHERE account_id=? AND content=?)
      ${actor === 'assistant' ? `AND EXISTS (SELECT 1 FROM assistant_memory_settings s
        WHERE s.account_id = ? AND s.enabled = 1)` : ''}
      RETURNING id,content,source,created_at,updated_at`)
    .bind(...(actor === 'assistant'
      ? [newId, accountId, clean, source, now, now, accountId, MAX_MEMORIES, accountId, clean, accountId]
      : [newId, accountId, clean, 'user_edited', now, now, accountId, MAX_MEMORIES, accountId, clean])),
    db.prepare(`SELECT id,content,source,created_at,updated_at FROM assistant_memories
      WHERE account_id=? AND content=? LIMIT 1`).bind(accountId, clean),
  ]);
  if (actor === 'assistant' && rows(result[0])[0]?.enabled !== 1) throw new MemoryError('memory_disabled', 403);
  const saved = rows(result[1])[0] || rows(result[2])[0];
  if (!saved) throw new MemoryError('memory_limit_reached', 409);
  return { memory: dto(saved), action: rows(result[1]).length ? 'created' : 'unchanged' };
}

export async function deleteAssistantMemory(db, accountId, id, { actor = 'user' } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new MemoryError('invalid_memory_id');
  if (actor === 'assistant' && !await memoryEnabled(db, accountId)) throw new MemoryError('memory_disabled', 403);
  const result = await db.prepare(`DELETE FROM assistant_memories WHERE id = ? AND account_id = ?
    ${actor === 'assistant' ? `AND source != 'user_edited' AND EXISTS
      (SELECT 1 FROM assistant_memory_settings s WHERE s.account_id = ? AND s.enabled = 1)` : ''}`)
    .bind(...(actor === 'assistant' ? [id, accountId, accountId] : [id, accountId])).run();
  if (changes(result) !== 1) throw new MemoryError('memory_not_found', 404);
  return { ok: true };
}

export async function mergeAssistantMemories(db, accountId, { id, merge_ids: mergeIds, content, source, now = Date.now() }) {
  const clean = validContent(content);
  const ids = [id, ...(Array.isArray(mergeIds) ? mergeIds : [])];
  if (ids.length < 2 || ids.length > MAX_MEMORIES || new Set(ids).size !== ids.length
    || ids.some(value => typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value))) throw new MemoryError('invalid_memory_id');
  if (!['stated', 'inferred'].includes(source)) throw new MemoryError('invalid_source');
  if (!await memoryEnabled(db, accountId)) throw new MemoryError('memory_disabled', 403);
  const placeholders = ids.map(() => '?').join(',');
  // Every source row must still be editable and owned at transaction time.
  const guard = `(SELECT COUNT(*) FROM assistant_memories WHERE account_id = ?
    AND source != 'user_edited' AND id IN (${placeholders})) = ?
    AND EXISTS (SELECT 1 FROM assistant_memory_settings WHERE account_id = ? AND enabled = 1)`;
  const bindings = [accountId, ...ids, ids.length, accountId];
  const results = await db.batch([
    db.prepare(`UPDATE assistant_memories SET content = ?, source = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND ${guard}`).bind(clean, source, now, id, accountId, ...bindings),
    db.prepare(`DELETE FROM assistant_memories WHERE account_id = ? AND id IN (${mergeIds.map(() => '?').join(',')})
      AND ${guard}`).bind(accountId, ...mergeIds, ...bindings),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== mergeIds.length) throw new MemoryError('memory_not_found', 404);
  const saved = await db.prepare(`SELECT id, content, source, created_at, updated_at
    FROM assistant_memories WHERE id = ? AND account_id = ?`).bind(id, accountId).first();
  return { memory: dto(saved), action: 'merged', deletedIds: mergeIds };
}
