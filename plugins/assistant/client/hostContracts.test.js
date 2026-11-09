// These implementation contracts moved with their owning plugin source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const sources={
  "./components/AssistantView.jsx": "./AssistantView.jsx",
  "./components/AiReviewConversation.jsx": "./AssistantConversation.jsx",
  "./components/AiReviewChrome.jsx": "./Composer.jsx",
  "./services/aiPlayerActionDispatch.js": "./actionDispatch.js",
  "./services/aiThreadSync.js": "./thread.js",
  "./plugins/assistant/client.js": "./client.js",
  "./assistantPlayerActions.js": "./playerActions.js",
  "../../server/src/tools/managePlaylist.js": "../server/tools/managePlaylist.js"
};
const readSource = path => { if (!Object.hasOwn(sources,path)) throw new Error('Unknown plugin test source: '+path); return readFileSync(new URL(sources[path],import.meta.url),'utf8'); };

test("assistant page follows rendered updates while preserving manual history scrolling", () => {
const page = readSource('./components/AssistantView.jsx');
assert.match(page, /const shouldFollowMessagesRef = React\.useRef\(true\)/);
assert.match(page, /const pendingAutoScrollRef = React\.useRef\(false\)/);
assert.match(page, /const scheduleScrollToLatest = React\.useCallback/);
assert.match(page, /if \(updateFollowing && !pendingAutoScrollRef\.current\) \{/);
assert.match(page, /if \(shouldFollowMessagesRef\.current\) \{\s*scrollToBottom\(\);/);
});

test("assistant visitor template is retired in favor of the standalone instance gate", () => {
const page = readSource('./components/AssistantView.jsx');
const conversation = readSource('./components/AiReviewConversation.jsx');
const chrome = readSource('./components/AiReviewChrome.jsx');
assert.doesNotMatch(conversation, /!authenticated|登录后开启|立即登录|onLogin/);
assert.doesNotMatch(chrome, /登录后发送消息|onLogin/);
assert.doesNotMatch(page, /handleLogin|onLogin/);
assert.match(page, /setMessages\(\[\]\);/);
assert.match(page, /if \(!isAuthed\) \{\s*setPhase\('ready'\);/);
assert.match(page, /abortControllerRef\.current\?\.abort\(\)/);
assert.match(page, /if \(!isLive\(\) \|\| !isAuthed \|\| \(!text && !attachments.length\) \|\| attachmentsBusy \|\| isLoading \|\| sendingRef\.current \|\| phase !== 'ready'\) return;/);
assert.doesNotMatch(page, /localStorage|Turnstile|turnstile|captcha/i);
});

test("account playlists remain independent while the assistant page uses account threads", () => {
const assistant = readSource('./components/AssistantView.jsx');
const conversation = readSource('./components/AiReviewConversation.jsx');
const playerActionDispatch = readSource('./services/aiPlayerActionDispatch.js');
const threadSync = readSource('./services/aiThreadSync.js');
const assistantTransport = readSource('./plugins/assistant/client.js');
const manageTool = readSource('../../server/src/tools/managePlaylist.js');
assert.match(assistant, /consumeSseJsonStream\(response\.body/);
assert.match(playerActionDispatch, /export async function dispatchAiPlayerAction/);
assert.match(assistant, /event\.type === 'player_action'/);
assert.match(conversation, /role="status" aria-live="polite"/);
assert.doesNotMatch(assistant, /client_tool_request/);
assert.doesNotMatch(assistant, /compactXiaoaHistoryForStorage|GUEST_CHAT_STORAGE_KEY|readGuestMessages/);
assert.match(conversation, /text-\[var\(--danger\)\]/);
assert.doesNotMatch(assistant, /playlistProposal|playlist_proposal|localPlaylist:|确认生成小A歌单/);
assert.doesNotMatch(assistant, /handleSaveSong|加入小A歌单|newPlaylistName|创建并加入/);
for (const action of ['list', 'read', 'create', 'add_songs', 'remove_songs', 'clear', 'replace_songs', 'reorder_songs', 'update_metadata', 'delete']) {
    assert.match(manageTool, new RegExp(`'${action}'`));
  }
assert.match(assistant, /assistantFetch\(host, url, init\)/);
assert.match(assistantTransport, /host\.requestResponse\(url\.slice\(prefix\.length\)/);
assert.doesNotMatch(assistant, /getXiaoaApiBase|if \(!xiaoaApiBase\)|getApiBaseUrl\(\) \|\| ''/);
assert.match(threadSync, /fetchImpl\(`\$\{apiBase\}\/api\/ai\/thread`/);
assert.match(assistant, /fetchCloudThread\(\{ signal, fetchImpl: authenticatedFetch \}\)/);
assert.doesNotMatch(assistant, /site: 'music'/);
assert.doesNotMatch(assistant, /capabilities:\s*\[/);
assert.doesNotMatch(assistant, /role:\s*['"]system['"]/);
assert.match(assistant, /message: text/);
assert.match(assistant, /revision: threadRevisionRef\.current/);
assert.doesNotMatch(assistant, /messages: normalizeXiaoaMessages/);
assert.match(assistant, /client_message_id: clientMessageId/);
assert.doesNotMatch(assistant, /X-XiaoA-CSRF|context: normalizeXiaoaContext/);
assert.doesNotMatch(assistant, /XiaoaArticleCardGroup|assistantArticles|msg\.articles/);
assert.match(assistant, /`\$\{getApiBaseUrl\(\)\}\/api\/ai\/chat`/);
assert.doesNotMatch(assistant, /applyPlaySongNow|insertAndPlay|applyReplacePlayerQueue|applyPlayerQueueEdit|applyPlayerControl/);
});

test("Xiaoa chat and bootstrap are authenticated-only and no longer ship visitor verification", () => {
const page = readSource('./components/AssistantView.jsx');
assert.match(page, /if \(!isAuthed\) return undefined;[\s\S]*?\/api\/ai\/bootstrap/);
assert.match(page, /if \(!isLive\(\) \|\| !isAuthed \|\| \(!text && !attachments.length\) \|\| attachmentsBusy \|\| isLoading \|\| sendingRef\.current \|\| phase !== 'ready'\) return;/);
assert.doesNotMatch(page, /Turnstile|turnstile|captcha|cf_turnstile_response|PUBLIC_TURNSTILE_SITEKEY/i);
});

test("current-only frontend rejects retired shell, URL, origin, storage, and player action formats", () => {
const drawer = readSource('./components/AssistantView.jsx');
const playerActions = readSource('./assistantPlayerActions.js');
assert.doesNotMatch(drawer, /const action = eventData\.action|eventData\.song \|\||eventData\.songs/);
assert.doesNotMatch(playerActions, /player_seek|seek_seconds|seek_percent|position_seconds \?\?|position_percent \?\?/);
});

test("identity-aware song reads include credentials and rely on the global session gate", () => {
const drawer = readSource('./components/AssistantView.jsx');
assert.doesNotMatch(drawer, /fetchSongById\(songId\)|music-play-song-id/);
assert.doesNotMatch(drawer, /\/api\/songs\?id=/);
});

test("assistant page owns input, messages and pending state", () => {
const page = readSource('./components/AssistantView.jsx');
assert.match(page, /const \[inputText, setInputText\] = React\.useState\(''\);/);
assert.match(page, /const \[messages, setMessages\] = React\.useState\(\[\]\);/);
assert.match(page, /const \[isLoading, setIsLoading\] = React\.useState\(false\);/);
});

test("assistant page stops its stream and typewriter when cancelled", () => {
const page = readSource('./components/AssistantView.jsx');
assert.match(page, /const handleStopGeneration = React\.useCallback/);
assert.match(page, /abortControllerRef\.current\.abort\(\)/);
assert.match(page, /typewriter\?\.cancel\(\)/);
assert.match(page, /if \(!completed \|\| !canonicalThread\)/);
});

test("assistant page retains stream and composer without reply song cards or retired prompt chips", () => {
const page = readSource('./components/AssistantView.jsx');
const chrome = readSource('./components/AiReviewChrome.jsx');
const conversation = readSource('./components/AiReviewConversation.jsx');
assert.doesNotMatch(`${page}\n${conversation}`, /getAiPromptChips|resolveAiPromptChipText|PROMPT_CHIP_ICONS|activeChips|shouldShowChips|快捷 Prompt Chips/);
assert.match(page, /event\.type === 'thread_state'/);
assert.match(page, /event\.type === 'content'/);
assert.match(page, /event\.type === 'done'/);
assert.match(chrome, /placeholder=\{t\("聊聊音乐…"\)\}/);
assert.doesNotMatch(conversation, /XiaoaMessageMusicCards|displaySongs|message\.songs/);
assert.doesNotMatch(page, /displaySongs/);
});

test('assistant route keeps the legacy chat endpoint without retired client playlist proposals', () => {
const worker=readFileSync(new URL('../server/handler.js',import.meta.url),'utf8');
assert.match(worker, /\/api\/ai\/chat/);
assert.doesNotMatch(worker, /playlist_proposal|normalizeLocalPlaylistContext|isPlaylistGenerationRequest/);
assert.doesNotMatch(worker, /localStorage/);
assert.doesNotMatch(worker, /\/api\/ai\/playlist['"]/);
assert.match(worker, /path === '\/api\/ai\/chat' && request\.method === 'POST'/);
});
