// D1 Free allows 50 binding calls in one Worker invocation. Reserve calls for
// persisting a failed turn and leave room for the outer HTTP/session router.
// This is a resource budget, never a wall-clock deadline or authorization cache.
const raw = Symbol('assistantBudgetStatement');
export function createAssistantBindingBudget(db, { limit = 41, recoveryLimit = 45 } = {}) {
  let used = 0, recovering = false;
  const spend = () => {
    if (used >= (recovering ? recoveryLimit : limit)) {
      const error = new Error('AI_UPSTREAM_FAILURE'); error.code = 'ASSISTANT_BINDING_BUDGET'; throw error;
    }
    used += 1;
  };
  const wrapped = {
    prepare(sql) {
      let statement = db.prepare(sql);
      const result = { get [raw]() { return statement; },
        bind(...values) { statement = statement.bind(...values); return result; },
        first(...args) { spend(); return statement.first(...args); },
        all(...args) { spend(); return statement.all(...args); },
        run(...args) { spend(); return statement.run(...args); },
      };
      return result;
    },
    batch(statements) { spend(); return db.batch(statements.map(statement => statement[raw] || statement)); },
  };
  return { db: wrapped, recover() { recovering = true; }, get used() { return used; } };
}
