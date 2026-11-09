import { createInvocationDatabase, invocationBudget } from "@flaretune/plugin-sdk/server/invocation-database";
// A lyric invocation reserves five binding calls for authoritative settlement.
export const createLyricsInvocationDatabase = (db, signal) => createInvocationDatabase(db, signal, {
  limit: 50, settlementReserve: 5, settlementRoom: 12, exhaustedCode: 'LYRICS_INVOCATION_BUDGET_EXHAUSTED',
});
export const lyricsInvocationBudget = invocationBudget;
