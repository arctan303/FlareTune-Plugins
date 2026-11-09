import { t, useLocale, createAiResponseTypewriter, reconcileAiResponseContent, consumeSseJsonStream,
    ImagePreviewDialog } from "@flaretune/plugin-sdk";
import React from 'react';
import { AiReviewComposer } from './Composer.jsx';
import AiReviewConversation from './AssistantConversation.jsx';
import { appendThoughtProcessEntry, appendToolProcessEntry, finishToolProcessEntry } from '../shared/assistantProcessTrace.js';
import { dispatchLocalAssistantPlayerAction } from './localPlayer.js';
import { ArrowDown } from 'lucide-react';
import { assistantFetch, registerConversationClear, loadThinkingPreference, saveThinkingPreference } from "./client.js";
import { fetchCloudThread, mergeAssistantProcessMessages, pendingAssistantTurn } from "./thread.js";
import { optimisticAssistantUserMessage } from "./request.js";
import { assistantFailureMessage, withAssistantFailure } from "./failure.js";
import { captureAssistantLiveContext } from "./liveContext.js";
import { confirmAssistantPlaylistDeletion, rebindAssistantPlaylistConfirmations } from "./playlistDeletion.js";
import AssistantMemoryView from "./AssistantMemoryView.jsx";
import AssistantAttachments from "./AssistantAttachments.jsx";
import { resolveAssistantImagePreview } from "./imagePreview.js";
import { DEFAULT_ASSISTANT_NAME, resolveAssistantWelcome } from "./welcome.js";

const toUiMessages = (list) => (Array.isArray(list) ? list : []).map((message) => ({
    ...message,
    createdAt: Number(message?.createdAt) > 0 ? Number(message.createdAt) : undefined,
}));

export default function AssistantView({ host, section = 'conversation', context = {} }) {
    useLocale();
    const authSession = host.session.get() || {};
    const viewActiveRef = React.useRef(true);
    const isLive = React.useCallback((owner = host.session.get()?.user?.accountId) => viewActiveRef.current
        && host.isCurrent() && host.session.get()?.user?.accountId === owner, [host]);
    const showToast = React.useCallback(message => { if (isLive()) host.notify(message); }, [host, isLive]);
    const setAuthSession = React.useCallback(() => { if (isLive()) host.session.expire(); }, [host, isLive]);
    const authenticatedFetch = React.useCallback((url, init) => assistantFetch(host, url, init), [host]);
    const getApiBaseUrl = () => '';
    const [enableThinking, updateThinking] = React.useState(() => loadThinkingPreference(host));
    const setEnableThinking = value => { if (!host.isCurrent()) return; saveThinkingPreference(host, value); updateThinking(value); };
    const [hasCurrentSong, setHasCurrentSong] = React.useState(() => Boolean(host.player.getSnapshot().currentSong?.id));
    React.useEffect(() => host.player.subscribe(() => setHasCurrentSong(Boolean(host.player.getSnapshot().currentSong?.id))), [host]);
    const placement = context.playerPlacement || 'sidebar';
    const isAuthed = Boolean(authSession?.authenticated);
    const accountId = authSession?.user?.accountId || null;

    const [messages, setMessages] = React.useState([]);
    const [requestFailure, setRequestFailure] = React.useState(null);
    const visibleMessages = withAssistantFailure(messages,
        requestFailure?.accountId === accountId ? requestFailure : null);
    const canContinue = visibleMessages.at(-1)?.role === 'assistant' && visibleMessages.at(-1)?.isError === true;
    const [imageSelection, setImageSelection] = React.useState(null);
    const imagePreview = resolveAssistantImagePreview(visibleMessages, imageSelection, accountId);
    React.useEffect(() => {
        if (imageSelection && (!imagePreview || section !== 'conversation')) setImageSelection(null);
    }, [imageSelection, imagePreview, section]);
    const [inputText, setInputText] = React.useState('');
    const [attachments, setAttachments] = React.useState([]);
    const [attachmentsBusy, setAttachmentsBusy] = React.useState(false);
    const [imageInput, setImageInput] = React.useState(false);
    const [imageNotice, setImageNotice] = React.useState('');
    const [isLoading, setIsLoading] = React.useState(false);
    const [pendingTurn, setPendingTurn] = React.useState(null);
    const isProcessing = isLoading || Boolean(pendingTurn);
    const [processClock, setProcessClock] = React.useState(() => Date.now());
    const [showScrollBottom, setShowScrollBottom] = React.useState(false);
    const [welcomeConfig, setWelcomeConfig] = React.useState({ accountId: null, name: DEFAULT_ASSISTANT_NAME, ready: false });
    const welcomeReady = welcomeConfig.ready && welcomeConfig.accountId === accountId;
    const welcomeText = resolveAssistantWelcome(welcomeConfig.accountId === accountId ? welcomeConfig : null);
    const [phase, setPhase] = React.useState('skeleton');
    const [expandedDetails, setExpandedDetails] = React.useState({});
    const [playlistConfirmations, setPlaylistConfirmations] = React.useState({});

    const toggleExpandDetails = React.useCallback((msgId) => {
        setExpandedDetails((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
    }, []);

    React.useEffect(() => {
        if (!isLoading) return undefined;
        setProcessClock(Date.now());
        const timer = window.setInterval(() => setProcessClock(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isLoading]);

    const chatContainerRef = React.useRef(null);
    const textareaRef = React.useRef(null);
    const attachmentsRef = React.useRef(null);
    const abortControllerRef = React.useRef(null);
    const sendingRef = React.useRef(false);
    const activeRequestRef = React.useRef(null);
    const stopRequestRef = React.useRef(null);
    const shouldFollowMessagesRef = React.useRef(true);
    const pendingAutoScrollRef = React.useRef(false);
    const scrollFrameRef = React.useRef(null);
    const threadRevisionRef = React.useRef(0);
    const recentPlaybackRef = React.useRef([]);
    const playerActionReceiptsRef = React.useRef([]);
    const executedPlayerActionIdsRef = React.useRef(new Set());
    const pendingPlaylistDecisionIdsRef = React.useRef(new Set());
    const accountIdRef = React.useRef(accountId);
    accountIdRef.current = accountId;

    React.useEffect(() => {
        let previous = host.player.getSnapshot().currentSong;
        return host.player.subscribe(() => {
            const state = host.player.getSnapshot();
            const current = state.currentSong;
            if (previous?.id && previous.id !== current?.id) {
                recentPlaybackRef.current = [...recentPlaybackRef.current, {
                    title: previous.title, artist: previous.artist,
                }].slice(-3);
            }
            previous = current;
        });
    }, [host]);

    React.useEffect(() => {
        recentPlaybackRef.current = [];
        playerActionReceiptsRef.current = [];
        executedPlayerActionIdsRef.current.clear();
        pendingPlaylistDecisionIdsRef.current.clear();
        setPlaylistConfirmations({});
        setRequestFailure(null);
        setInputText('');
        setAttachments([]); setAttachmentsBusy(false); setImageInput(false); setImageNotice('');
    }, [accountId]);

    React.useEffect(() => {
        setWelcomeConfig({ accountId, name: DEFAULT_ASSISTANT_NAME, ready: !isAuthed });
        if (!isAuthed) return undefined;
        const controller = new AbortController();
        authenticatedFetch(`${getApiBaseUrl()}/api/ai/bootstrap`, { credentials: 'include', signal: controller.signal })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (controller.signal.aborted || !isLive(accountId)) return;
                const assistant = data?.assistant;
                setImageInput(data?.imageInput?.enabled === true);
                const name = typeof assistant?.name === 'string' && assistant.name.trim()
                    ? assistant.name.trim()
                    : DEFAULT_ASSISTANT_NAME;
                setWelcomeConfig({ accountId, name, welcomeMessage: assistant?.welcomeMessage, ready: true });
            })
            .catch(() => {
                if (!controller.signal.aborted && isLive(accountId)) setWelcomeConfig({ accountId, name: DEFAULT_ASSISTANT_NAME, ready: true });
            });
        return () => controller.abort();
    }, [isAuthed, accountId]);

    const scrollToBottom = React.useCallback((smooth = false) => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTo({
                top: chatContainerRef.current.scrollHeight,
                behavior: smooth ? 'smooth' : 'auto',
            });
            shouldFollowMessagesRef.current = true;
            if (!smooth) setShowScrollBottom(false);
        }
    }, []);

    const handleComposerHeightChange = React.useCallback(() => {
        if (shouldFollowMessagesRef.current) scrollToBottom();
    }, [scrollToBottom]);

    const checkScrollBottomState = React.useCallback((updateFollowing = false) => {
        if (!chatContainerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
        const isOverflowing = scrollHeight > clientHeight + 20;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 60;
        if (updateFollowing && !pendingAutoScrollRef.current) {
            shouldFollowMessagesRef.current = isNearBottom;
        }
        setShowScrollBottom(isOverflowing && !isNearBottom);
    }, []);

    const handleScroll = React.useCallback(() => {
        checkScrollBottomState(true);
    }, [checkScrollBottomState]);

    const handleUserScrollIntent = React.useCallback(() => {
        shouldFollowMessagesRef.current = false;
        pendingAutoScrollRef.current = false;
        if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
    }, []);

    React.useEffect(() => {
        checkScrollBottomState();
    }, [messages, requestFailure, isLoading, checkScrollBottomState]);

    const scheduleScrollToLatest = React.useCallback((force = false) => {
        if (force) shouldFollowMessagesRef.current = true;
        if (!shouldFollowMessagesRef.current) return;
        if (scrollFrameRef.current !== null) {
            cancelAnimationFrame(scrollFrameRef.current);
        }
        pendingAutoScrollRef.current = true;
        scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = requestAnimationFrame(() => {
                scrollFrameRef.current = null;
                pendingAutoScrollRef.current = false;
                if (shouldFollowMessagesRef.current) {
                    scrollToBottom();
                }
            });
        });
    }, [scrollToBottom]);

    React.useLayoutEffect(() => { if (section === 'conversation') scheduleScrollToLatest(); },
        [section, messages, requestFailure, scheduleScrollToLatest]);
    React.useEffect(() => { viewActiveRef.current = true;
        return () => { viewActiveRef.current = false; abortControllerRef.current?.abort();
            if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current); };
    }, [host]);

    const applyThread = React.useCallback((thread, expectedAccountId) => {
        if (!expectedAccountId || !isLive(expectedAccountId) || accountIdRef.current !== expectedAccountId) return false;
        if (!thread || !Number.isSafeInteger(thread.revision)) return false;
        if (thread.revision < threadRevisionRef.current) return false;
        threadRevisionRef.current = thread.revision;
        const pending = pendingAssistantTurn(thread);
        setPendingTurn(pending ? { ...pending, accountId: expectedAccountId } : null);
        setMessages((previous) => toUiMessages(mergeAssistantProcessMessages(thread.messages, previous)));
        scheduleScrollToLatest();
        return true;
    }, [scheduleScrollToLatest, isLive]);

    const syncThread = React.useCallback(async ({ signal, expectedAccountId = accountIdRef.current } = {}) => {
        const { thread } = await fetchCloudThread({ signal, fetchImpl: authenticatedFetch });
        if (!signal?.aborted && isLive(expectedAccountId)) applyThread(thread, expectedAccountId);
    }, [applyThread, authenticatedFetch, isLive]);

    // A reload or lost stream can leave a live reservation without a local
    // fetch controller. Keep the existing stop action available and observe
    // completion/stale recovery instead of repeatedly asking for a refresh.
    React.useEffect(() => {
        if (isLoading || !isAuthed || !pendingTurn || pendingTurn.accountId !== accountId) return undefined;
        const controller = new AbortController();
        let timer;
        const observe = async () => {
            try { await syncThread({ signal: controller.signal, expectedAccountId: accountId }); }
            catch (error) {
                if (!controller.signal.aborted && accountIdRef.current === accountId && error.status === 401) {
                    setAuthSession({ authenticated: false, user: null, initialized: true });
                }
            } finally {
                if (!controller.signal.aborted && isLive(accountId)) timer = window.setTimeout(observe, 15000);
            }
        };
        timer = window.setTimeout(observe, 15000);
        return () => { window.clearTimeout(timer); controller.abort(); };
    }, [accountId, isAuthed, isLoading, pendingTurn?.clientMessageId, pendingTurn?.accountId, setAuthSession, syncThread]);

    React.useEffect(() => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setIsLoading(false);
        setPendingTurn(null);
        threadRevisionRef.current = 0;
        setMessages([]);
        setPlaylistConfirmations({});
        setExpandedDetails({});
        if (!isAuthed) {
            setPhase('ready');
            return undefined;
        }
        const controller = new AbortController();
        let threadLoadFailed = false;
        setPhase('skeleton');
        syncThread({ signal: controller.signal, expectedAccountId: accountId })
            .catch((error) => {
                if (controller.signal.aborted || !isLive(accountId) || accountIdRef.current !== accountId) return;
                threadLoadFailed = true;
                if (error?.status === 401) {
                    setAuthSession({ authenticated: false, user: null, initialized: true });
                } else {
                    showToast(t("对话历史暂时无法载入，请稍后刷新。"));
                    setMessages([]);
                }
            })
            .finally(() => { if (!controller.signal.aborted && isLive(accountId) && accountIdRef.current === accountId) setPhase(threadLoadFailed ? 'failed' : 'ready'); });
        return () => controller.abort();
    }, [isAuthed, accountId, setAuthSession, syncThread]);

    const handleStopGeneration = React.useCallback(() => {
            if (!isLive()) return;
            const active = activeRequestRef.current || pendingTurn;
            if (active?.accountId === accountIdRef.current) {
                stopRequestRef.current = authenticatedFetch(`${getApiBaseUrl()}/api/ai/stop`, {
                    method: 'POST', credentials: 'include',
                    body: JSON.stringify({ client_message_id: active.clientMessageId }),
                }).then(async response => {
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.message || '停止失败，请重试。');
                    applyThread(data.thread, active.accountId);
                    return data;
                }).catch(error => {
                    if (accountIdRef.current === active.accountId) showToast(t(error.message));
                    return null;
                });
            }
            if (abortControllerRef.current) abortControllerRef.current.abort();
    }, [applyThread, pendingTurn, authenticatedFetch, isLive]);

    const handleClearMessages = React.useCallback(async () => {
        if (!isLive()) return false;
        if (!window.confirm(t('确定要清空与小A的全部对话记录吗？'))) return false;
        handleStopGeneration();
        await stopRequestRef.current;
        const requestAccountId = accountIdRef.current;
        if (!isLive(requestAccountId)) return false;
        try {
            const response = await authenticatedFetch(`${getApiBaseUrl()}/api/ai/thread`, {
                method: 'DELETE',
                credentials: 'include',
                body: JSON.stringify({ revision: threadRevisionRef.current }),
            });
            const data = await response.json().catch(() => ({}));
            if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId) return;
            if (response.status === 409 && applyThread(data.thread, requestAccountId)) {
                showToast(t("对话已在其他页面更新，请确认后重试清空。"));
                return;
            }
            if (response.status === 401) {
                setAuthSession({ authenticated: false, user: null, initialized: true });
                return;
            }
            if (!response.ok || !applyThread(data.thread, requestAccountId)) {
                throw new Error(data.message || '清空失败，请重试。');
            }
            showToast(t("对话历史已清空"));
            setPlaylistConfirmations({});
            setRequestFailure(null);
            return true;
        } catch (error) {
            if (isLive(requestAccountId) && accountIdRef.current === requestAccountId) showToast(t(error.message || '清空失败，请重试。'));
        }
    }, [applyThread, handleStopGeneration, setAuthSession, authenticatedFetch, isLive, showToast]);

    React.useEffect(() => {
        return registerConversationClear(host, handleClearMessages);
    }, [host, handleClearMessages]);

    const handlePlaylistConfirmationDecision = React.useCallback(async (id, decision) => {
        const item = playlistConfirmations[id];
        if (!isLive() || !item || item.status !== 'pending' || pendingPlaylistDecisionIdsRef.current.has(id)) return;
        pendingPlaylistDecisionIdsRef.current.add(id);
        if (decision === 'keep') {
            setPlaylistConfirmations((prev) => ({ ...prev, [id]: { ...item, status: 'kept' } }));
            pendingPlaylistDecisionIdsRef.current.delete(id);
            return;
        }
        if (decision !== 'delete') {
            pendingPlaylistDecisionIdsRef.current.delete(id);
            return;
        }
        setPlaylistConfirmations((prev) => ({ ...prev, [id]: { ...item, status: 'deleting' } }));
        try {
            const outcome = await confirmAssistantPlaylistDeletion(item.confirmation, {
                isCurrent: () => accountIdRef.current === item.accountId
                    && isLive(item.accountId),
                deletePlaylist: (playlistId, revision) => host.request('playlist-delete', { method: 'POST', body: { playlistId, revision } }),
            });
            if (isLive(item.accountId) && accountIdRef.current === item.accountId) {
                setPlaylistConfirmations((prev) => ({ ...prev, [id]: {
                    ...item, status: outcome === 'deleted' ? 'deleted' : 'account_changed',
                } }));
            }
        } catch (error) {
            if (isLive(item.accountId) && accountIdRef.current === item.accountId) {
                setPlaylistConfirmations((prev) => ({ ...prev, [id]: {
                    ...item, status: 'failed', error: error.message || '删除失败，请重试。',
                } }));
            }
        } finally {
            pendingPlaylistDecisionIdsRef.current.delete(id);
        }
    }, [playlistConfirmations, host, isLive]);

    const handleSend = React.useCallback(async (overrideText) => {
        const draft = (typeof overrideText === 'string' ? overrideText : inputText).trim();
        const text = draft || (canContinue && !attachments.length ? t('继续上一条未完成的任务') : '');
        if (pendingTurn) return;
        if (!isLive() || !isAuthed || (!text && !attachments.length) || attachmentsBusy || isLoading || sendingRef.current || phase !== 'ready') return;
        sendingRef.current = true;

        setInputText('');
        setRequestFailure(null);
        setImageNotice('');
        const clientMessageId = crypto.randomUUID();
        const userMsgId = `user-${clientMessageId}`;
        const assistantMsgId = `assistant-${clientMessageId}`;
        const userMessage = optimisticAssistantUserMessage(userMsgId, text, attachments);
        const sentImages = userMessage.images;
        const sentAttachments = attachments;
        setAttachments([]);

        const newMessages = [
            ...messages,
            userMessage,
            { id: assistantMsgId, role: 'assistant', content: '', createdAt: Date.now() + 1, isGenerating: true },
        ];
        setMessages(newMessages);
        setIsLoading(true);
        scheduleScrollToLatest(true);

        const controller = new AbortController();
        abortControllerRef.current = controller;
        const requestAccountId = authSession?.user?.accountId;
        activeRequestRef.current = { accountId: requestAccountId, clientMessageId };
        stopRequestRef.current = null;
        const sentReceipts = playerActionReceiptsRef.current.slice(-10);
        const pendingPlayerActions = [];
        let lastPlayerAction = Promise.resolve();
        let canonicalThread = null;
        let completed = false;
        let renderedContent = '';
        let streamedContent = '';
        let liveThought = '';
        let liveProcessEntries = [];
        let typewriter;
        let accepted = false;
        let rejected = false;

        try {
            typewriter = createAiResponseTypewriter({
                onDisplay: (renderedText) => {
                    if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
                    renderedContent = renderedText;
                    setMessages((prev) =>
                        prev.map((m) => (m.id === assistantMsgId ? { ...m, content: renderedText, isGenerating: true } : m))
                    );
                    scheduleScrollToLatest();
                },
            });

            const response = await authenticatedFetch(`${getApiBaseUrl()}/api/ai/chat`, {
                method: 'POST',
                credentials: 'include',
                signal: controller.signal,
                body: JSON.stringify({
                    message: text,
                    client_message_id: clientMessageId,
                    revision: threadRevisionRef.current,
                    enable_thinking: enableThinking,
                    ...(!draft && canContinue && !sentImages.length && visibleMessages.at(-1)?.turnId
                        ? { continue_turn_id: visibleMessages.at(-1).turnId } : {}),
                    ...(sentImages.length ? { image_ids: sentImages.map(image => image.id) } : {}),
                    context: captureAssistantLiveContext(host.player.getSnapshot(),
                        recentPlaybackRef.current, sentReceipts),
                }),
            });
            if (!response.ok) {
                rejected = true;
                const data = await response.json().catch(() => ({}));
                if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
                if (response.status === 409) applyThread(data.thread, requestAccountId);
                if (data.error === 'duplicate_message') accepted = true;
                if (data.error === 'assistant_images_disabled') { setImageInput(false); setAttachments([]); setInputText(text); }
                if (response.status === 401) {
                    setAuthSession({ authenticated: false, user: null, initialized: true });
                }
                throw Object.assign(new Error(data.message || t('助手暂时无法回应 ({status})', { status: response.status })), { code: data.error });
            }
            accepted = true;
            await consumeSseJsonStream(response.body, {
                signal: controller.signal,
                onEvent: async (event) => {
                    if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
                    if (event.type === 'image_notice' && typeof event.message === 'string') {
                        setImageNotice(event.message);
                    } else if (event.type === 'content_delta' && typeof event.content === 'string') {
                        const respondedAt = Date.now();
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processingStartedAt: message.processingStartedAt || respondedAt }
                            : message));
                        streamedContent += event.content;
                        typewriter.append(event.content);
                    } else if (event.type === 'content_reset') {
                        streamedContent = '';
                        typewriter.reset();
                    } else if (event.type === 'content' && typeof event.content === 'string') {
                        const respondedAt = Date.now();
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processingStartedAt: message.processingStartedAt || respondedAt }
                            : message));
                        const correction = reconcileAiResponseContent(streamedContent, event.content);
                        if (correction.reset) typewriter.reset();
                        streamedContent = event.content;
                        typewriter.append(correction.append);
                    } else if (event.type === 'thought' && typeof event.content === 'string') {
                        const respondedAt = Date.now();
                        const start = liveThought.length;
                        liveThought = `${liveThought}${event.content}`.slice(0, 100000);
                        liveProcessEntries = appendThoughtProcessEntry(liveProcessEntries, start, liveThought.length);
                        const thought = liveThought;
                        const processEntries = liveProcessEntries;
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, thought, processEntries,
                                processingStartedAt: message.processingStartedAt || respondedAt }
                            : message));
                    } else if (event.type === 'tool_call') {
                        const respondedAt = Date.now();
                        liveProcessEntries = appendToolProcessEntry(liveProcessEntries, {
                            id: event.id, name: event.displayName || event.name || '工具调用', progress: event.progress,
                        });
                        const processEntries = liveProcessEntries;
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processingStartedAt: message.processingStartedAt || respondedAt,
                                processEntries }
                            : message));
                    } else if (event.type === 'tool_result') {
                        if (event.name === 'remember_user' && event.data?.ok === true
                            && ['created', 'updated', 'deleted', 'merged'].includes(event.data.action)) {
                            showToast(t("记忆已更新"));
                        }
                        liveProcessEntries = finishToolProcessEntry(liveProcessEntries, {
                            id: event.id, summary: event.summary,
                            ok: event.data?.ok !== false || event.data?.error === 'CONFIRMATION_REQUIRED',
                        });
                        const processEntries = liveProcessEntries;
                        setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                            ? { ...message, processEntries }
                            : message));
                        if (event.name === 'manage_playlist' && event.data?.error === 'CONFIRMATION_REQUIRED') {
                            setPlaylistConfirmations((prev) => ({ ...prev, [event.id]: {
                                id: event.id, messageId: assistantMsgId, accountId: requestAccountId,
                                confirmation: event.data.confirmation, status: 'pending',
                            } }));
                        }
                    } else if (event.type === 'player_action' && typeof event.id === 'string') {
                        const key = `${requestAccountId}:${event.id}`;
                        if (executedPlayerActionIdsRef.current.has(key)) return;
                        executedPlayerActionIdsRef.current.add(key);
                        const action = lastPlayerAction.then(() => {
                            if (!requestAccountId || !isLive(requestAccountId)) {
                                return { ok: false, outcome: 'account_changed' };
                            }
                            return dispatchLocalAssistantPlayerAction(event.action, { host });
                        }).then((result) => {
                            if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId) return;
                            playerActionReceiptsRef.current = [...playerActionReceiptsRef.current, {
                                id: event.id, ok: result?.ok === true, outcome: result?.outcome || result?.error || 'unknown',
                            }].slice(-10);
                        }).catch(() => {
                            if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId) return;
                            playerActionReceiptsRef.current = [...playerActionReceiptsRef.current, {
                                id: event.id, ok: false, outcome: 'browser_execution_failed',
                            }].slice(-10);
                        });
                        lastPlayerAction = action;
                        pendingPlayerActions.push(action);
                    } else if (event.type === 'error') {
                        throw Object.assign(new Error(typeof event.message === 'string' && event.message.trim()
                            ? event.message.trim() : '小A暂时无法回应，请稍后再试。'), { code: event.error });
                    } else if (event.type === 'thread_state') {
                        canonicalThread = event.thread;
                    } else if (event.type === 'done') {
                        completed = true;
                    }
                },
            });
            await Promise.all(pendingPlayerActions);
            if (!completed || !canonicalThread) throw new Error('助手响应未完成，请刷新对话记录。');
            await typewriter.finish();
            if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId || controller.signal.aborted) return;
            const lastMessage = canonicalThread.messages?.at(-1);
            if (lastMessage?.role === 'assistant' && lastMessage.id) {
                setPlaylistConfirmations((prev) => rebindAssistantPlaylistConfirmations(
                    prev, assistantMsgId, lastMessage.id,
                ));
                setExpandedDetails((previous) => {
                    if (!Object.hasOwn(previous, assistantMsgId)) return previous;
                    const next = { ...previous, [lastMessage.id]: previous[assistantMsgId] };
                    if (lastMessage.id !== assistantMsgId) delete next[assistantMsgId];
                    return next;
                });
            }
            const visibleThread = lastMessage?.role === 'assistant' && liveProcessEntries.length > 0
                ? { ...canonicalThread, messages: mergeAssistantProcessMessages(canonicalThread.messages,
                    [{ ...lastMessage, thought: liveThought, processEntries: liveProcessEntries }]) }
                : canonicalThread;
            applyThread(visibleThread, requestAccountId);
            const sentIds = new Set(sentReceipts.map((item) => item.id));
            playerActionReceiptsRef.current = playerActionReceiptsRef.current.filter((item) => !sentIds.has(item.id));
        } catch (err) {
            typewriter?.cancel();
            if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId) return;
            const stopped = controller.signal.aborted;
            if (stopped) await stopRequestRef.current;
            if (!isLive(requestAccountId)) return;
            const failureContent = assistantFailureMessage(stopped ? { code: 'request_cancelled' } : err);
            setMessages(prev => prev.map(message => message.id === assistantMsgId
                ? { ...message, content: failureContent, partialContent: streamedContent || renderedContent,
                    thought: liveThought, processEntries: liveProcessEntries, isError: true, isGenerating: false } : message));
            if (rejected && !accepted) {
                setInputText(draft);
                if (imageInput) setAttachments(sentAttachments);
                setMessages(prev => prev.filter(message => ![userMsgId, assistantMsgId].includes(message.id)));
                showToast(t(failureContent));
                return;
            }
            setRequestFailure({ id: assistantMsgId, role: 'assistant', accountId: requestAccountId,
                clientMessageId, userMessage: newMessages.at(-2), content: failureContent,
                partialContent: streamedContent || renderedContent, errorCode: stopped ? 'request_cancelled' : err.code,
                thought: liveThought, processEntries: liveProcessEntries, createdAt: Date.now(), isError: true });
            if (!stopped && err.name !== 'AbortError') showToast(t(failureContent));
            if (isLive(requestAccountId) && host.session.get()?.authenticated) {
                await syncThread({ expectedAccountId: requestAccountId }).catch(() => {
                    if (!isLive(requestAccountId) || accountIdRef.current !== requestAccountId) return;
                    setMessages((prev) => prev.map((message) => message.id === assistantMsgId
                        ? { ...message, content: renderedContent || '请求未完成，请稍后刷新对话记录。', isGenerating: false, isError: true }
                        : message));
                });
            }
        } finally {
            sendingRef.current = false;
            if (isLive(requestAccountId) && accountIdRef.current === requestAccountId) setIsLoading(false);
            if (abortControllerRef.current === controller) abortControllerRef.current = null;
            if (activeRequestRef.current?.clientMessageId === clientMessageId) activeRequestRef.current = null;
            if (isLive(requestAccountId) && accountIdRef.current === requestAccountId) scheduleScrollToLatest();
        }
    }, [applyThread, authSession, attachments, attachmentsBusy, enableThinking, inputText, canContinue, visibleMessages, imageInput, isAuthed, isProcessing, messages, phase, scheduleScrollToLatest, setAuthSession, syncThread]);

    const handleFormSubmit = React.useCallback((e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        handleSend();
    }, [handleSend]);

    const handleKeyDown = React.useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handleSuggestionClick = React.useCallback((text) => {
        handleSend(text);
    }, [handleSend]);

    return (
        <>
        {section === 'memory' && <AssistantMemoryView host={host} />}
        <div style={{ display: section === 'memory' ? 'none' : undefined }} aria-hidden={section === 'memory'} className={`xiaoa-page assistant-page flex flex-col h-full w-full relative overflow-hidden select-text !pt-0 ${placement === 'dock' && hasCurrentSong ? 'assistant-page--with-dock' : ''}`}>

            {/* 对话区主体（通透流式布局） */}
            <div className="flex-1 min-h-0 flex flex-col w-full relative">
                <AiReviewConversation host={host}
                    containerRef={chatContainerRef}
                    expandedDetails={expandedDetails}
                    messages={visibleMessages}
                    playlistConfirmations={playlistConfirmations}
                    onPlaylistConfirmationDecision={handlePlaylistConfirmationDecision}
                    onPreviewImage={(messageId, imageId) => setImageSelection({ accountId, messageId, imageId })}
                    onScroll={handleScroll}
                    onUserScrollIntent={handleUserScrollIntent}
                    onToggleDetails={toggleExpandDetails}
                    phase={phase}
                    processClock={processClock}
                    welcomeReady={welcomeReady}
                    welcomeText={welcomeText}
                />

                <div className="assistant-composer-area relative w-full shrink-0">
                    {/* 回到底部按钮跟随输入区顶部，避免输入框增高后重叠 */}
                    <button
                        type="button"
                        onClick={() => scrollToBottom(true)}
                        data-visible={showScrollBottom}
                        disabled={!showScrollBottom}
                        aria-hidden={!showScrollBottom}
                        className="assistant-scroll-bottom p-2.5 rounded-full border border-[var(--line)] text-[var(--ink)] shadow-lg cursor-pointer z-20"
                        aria-label={t("回到底部")}
                    >
                        <ArrowDown size={17} />
                    </button>

                    <AiReviewComposer
                        canContinue={canContinue}
                        hasAttachments={attachments.length > 0}
                        attachmentsBusy={attachmentsBusy}
                        attachments={imageInput ? <AssistantAttachments host={host} ref={attachmentsRef} key={accountId} session={authSession} attachments={attachments} onChange={setAttachments} onBusy={setAttachmentsBusy} disabled={isProcessing || phase !== 'ready'} /> : null}
                        onAttachImage={imageInput ? () => attachmentsRef.current?.pick() : undefined}
                        onImageFiles={imageInput ? files => attachmentsRef.current?.addFiles(files) : undefined}
                        attachmentLimitReached={attachments.length >= 4}
                        authenticated={isAuthed}
                        enableThinking={enableThinking}
                        onToggleThinking={() => setEnableThinking(!enableThinking)}
                        textareaRef={textareaRef}
                        inputText={inputText}
                        isLoading={isProcessing}
                        phase={phase}
                        onInputChange={setInputText}
                        onKeyDown={handleKeyDown}
                        onSubmit={handleFormSubmit}
                        onStop={handleStopGeneration}
                        onHeightChange={handleComposerHeightChange}
                    />
                    {imageNotice && <p role="status" className="mx-auto max-w-3xl px-4 py-1 text-xs text-[var(--muted)]">{t(imageNotice)}</p>}
                </div>
            </div>
            {imagePreview && <ImagePreviewDialog key={imagePreview.url} image={imagePreview} onClose={() => setImageSelection(null)} />}
        </div>
        </>
    );
}

export const XiaoaView = AssistantView;
