import { createInvocationDatabase, invocationBudget } from "@flaretune/plugin-sdk/server/invocation-database";
// Reserve six binding calls for authoritative settlement, including the source chain final fresh gate and response.
export const createLyricsInvocationDatabase = (db, signal) => createInvocationDatabase(db, signal, {
  limit: 50, settlementReserve: 6, settlementRoom: 12, exhaustedCode: 'LYRICS_INVOCATION_BUDGET_EXHAUSTED',
});
export const lyricsInvocationBudget = invocationBudget;
