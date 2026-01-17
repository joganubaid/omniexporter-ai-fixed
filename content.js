// OmniExporter AI - Enterprise Edition
// content.js - Unified Platform Adapter

console.log("OmniExporter AI Content Script Active");

// ============================================
// SECURITY UTILITIES (Audit Fix)
// ============================================
const SecurityUtils = {
    // Validate UUID format to prevent injection
    isValidUuid: (uuid) => {
        if (!uuid || typeof uuid !== 'string') return false;
        // Allow alphanumeric, underscore, hyphen, 8-128 chars
        return /^[a-zA-Z0-9_-]{8,128}$/.test(uuid);
    },

    // Sanitize HTML to prevent XSS
    sanitizeHtml: (str) => {
        if (typeof str !== 'string') return '';
        return str.replace(/[&<>"']/g, (m) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[m]);
    },

    // Fetch with timeout to prevent hanging
    fetchWithTimeout: async (url, options = {}, timeoutMs = 30000) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            return response;
        } finally {
            clearTimeout(timeout);
        }
    },

    // Validate API response structure
    isValidApiResponse: (data) => {
        return data && typeof data === 'object';
    }
};

class ContentScriptManager {
    constructor() {
        this.messageHandler = null;
        this.cleanupFunctions = [];
    }

    initialize() {
        // Remove existing listener if any (safety against multiple injections)
        this.cleanup();

        this.messageHandler = (request, sender, sendResponse) => {
            this.handleMessage(request, sendResponse);
            return true; // Keep message channel open for async response
        };

        chrome.runtime.onMessage.addListener(this.messageHandler);

        // Cleanup on visibility change (optional optimization)
        const visibilityHandler = () => {
            if (document.hidden) {
                // We could pause things here if needed
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
        this.cleanupFunctions.push(() => {
            document.removeEventListener('visibilitychange', visibilityHandler);
        });

        // Fix 16: SPA Navigation Handling
        const navigationHandler = () => {
            const adapter = getPlatformAdapter();
            if (adapter) {
                const newUuid = adapter.extractUuid(window.location.href);
                console.log('[OmniExporter] SPA navigation detected, new conversation:', newUuid);
            }
        };

        // Handle browser back/forward
        window.addEventListener('popstate', navigationHandler);
        this.cleanupFunctions.push(() => {
            window.removeEventListener('popstate', navigationHandler);
        });

        // Intercept pushState/replaceState for SPA routing
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function (...args) {
            originalPushState.apply(this, args);
            navigationHandler();
        };

        history.replaceState = function (...args) {
            originalReplaceState.apply(this, args);
            navigationHandler();
        };

        this.cleanupFunctions.push(() => {
            history.pushState = originalPushState;
            history.replaceState = originalReplaceState;
        });

        console.log("OmniExporter AI Content Script Initialized");
    }

    cleanup() {
        if (this.messageHandler) {
            chrome.runtime.onMessage.removeListener(this.messageHandler);
            this.messageHandler = null;
        }
        this.cleanupFunctions.forEach(fn => fn());
        this.cleanupFunctions = [];
        console.log("OmniExporter AI Content Script Cleaned Up");
    }

    async handleMessage(request, sendResponse) {
        // Phase 4: Health check handler
        if (request.type === 'HEALTH_CHECK') {
            sendResponse({ healthy: true, timestamp: Date.now() });
            return;
        }

        const adapter = getPlatformAdapter();
        if (!adapter) {
            sendResponse({ success: false, error: "Unsupported platform." });
            return;
        }

        try {
            if (request.type === "EXTRACT_CONTENT") {
                await handleExtraction(adapter, sendResponse);
            } else if (request.type === "EXTRACT_CONTENT_BY_UUID") {
                await handleExtractionByUuid(adapter, request.payload.uuid, sendResponse);
            } else if (request.type === "GET_THREAD_LIST") {
                await handleGetThreadList(adapter, request.payload, sendResponse);
            } else if (request.type === "GET_THREAD_LIST_OFFSET") {
                await handleGetThreadListOffset(adapter, request.payload, sendResponse);
            } else if (request.type === "GET_SPACES") {
                await handleGetSpaces(adapter, sendResponse);
            } else if (request.type === "GET_PLATFORM_INFO") {
                sendResponse({ success: true, platform: adapter.name });
            }
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    }
}

const manager = new ContentScriptManager();
manager.initialize();

// Ensure cleanup on page unload
window.addEventListener('beforeunload', () => manager.cleanup());


/**
 * Normalize entries from any adapter format to expected blocks format
 * This ensures all platforms return data in the format popup.js expects
 * 
 * Adapters return various formats:
 * - ChatGPT: { entries: [{query_str, blocks}], title }
 * - Perplexity: Similar blocks format
 * - Gemini/Grok/DeepSeek: { detail: { entries: [{query, answer}] } }
 * - Or sometimes: { entries: [{query, answer}] }
 */
function normalizeEntries(detail, platform) {
    // Handle various possible data structures
    let entries = [];

    // Priority 1: Check if detail has entries directly (ChatGPT, Perplexity return this)
    if (detail?.entries && Array.isArray(detail.entries)) {
        entries = detail.entries;
    }
    // Priority 2: Check nested detail.detail.entries (Gemini/Grok/DeepSeek)
    else if (detail?.detail?.entries && Array.isArray(detail.detail.entries)) {
        entries = detail.detail.entries;
    }
    // Priority 3: If detail itself is an array
    else if (Array.isArray(detail)) {
        entries = detail;
    }
    // Priority 4: For adapters returning messages directly
    else if (detail?.messages && Array.isArray(detail.messages)) {
        entries = detail.messages;
    }

    // If no entries found, return empty
    if (!entries || entries.length === 0) {
        return [];
    }

    return entries.map((entry, index) => {
        // If already in expected format with valid blocks, return as-is
        if (entry.blocks && Array.isArray(entry.blocks) && entry.blocks.length > 0) {
            // Verify the blocks have content
            const hasContent = entry.blocks.some(b =>
                b?.markdown_block?.answer || b?.markdown_block?.chunks
            );
            if (hasContent) {
                return entry;
            }
        }

        // Extract query - try multiple possible keys
        const query = entry.query_str || entry.query || entry.question || entry.prompt || '';

        // Extract answer - try multiple possible keys
        let answer = '';

        // Check blocks first (might have empty blocks)
        if (entry.blocks && Array.isArray(entry.blocks)) {
            entry.blocks.forEach(block => {
                if (block?.markdown_block?.answer) {
                    answer += block.markdown_block.answer + '\n\n';
                } else if (block?.markdown_block?.chunks) {
                    answer += block.markdown_block.chunks.join('\n') + '\n\n';
                }
            });
        }

        // Fallback to flat answer fields
        if (!answer.trim()) {
            answer = entry.answer || entry.response || entry.text || entry.content || '';
        }


        // Convert to expected format
        return {
            query_str: query,
            query: query, // Keep for backward compatibility
            blocks: [{
                intended_usage: 'ask_text',
                markdown_block: {
                    answer: answer.trim()
                }
            }],
            // Preserve original fields
            created_datetime: entry.created_datetime || entry.create_time || new Date().toISOString(),
            updated_datetime: entry.updated_datetime || entry.update_time
        };
    });
}

/**
 * Handle Single Extraction (Current Chat)
 */
async function handleExtraction(adapter, sendResponse) {
    try {
        const uuid = adapter.extractUuid(window.location.href);
        if (!uuid) throw new Error(`Open a ${adapter.name} chat first.`);

        const detail = await adapter.getThreadDetail(uuid);

        // Normalize entries to expected format
        const normalizedEntries = normalizeEntries(detail, adapter.name);

        // Get title from various sources
        const title = detail?.title || document.title?.replace(` - ${adapter.name}`, '').trim() || 'Untitled';

        sendResponse({
            success: true,
            data: {
                title: title,
                uuid: uuid,
                detail: { entries: normalizedEntries },
                platform: adapter.name
            }
        });
    } catch (error) {
        console.error(`[OmniExporter] Extraction error:`, error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Handle Specific Thread Extraction
 */
async function handleExtractionByUuid(adapter, uuid, sendResponse) {
    try {
        const detail = await adapter.getThreadDetail(uuid);

        // Normalize entries to expected format
        const normalizedEntries = normalizeEntries(detail, adapter.name);
        const title = detail?.title || `Thread_${uuid}`;

        sendResponse({
            success: true,
            data: {
                title: title,
                uuid: uuid,
                detail: { entries: normalizedEntries },
                platform: adapter.name
            }
        });
    } catch (error) {
        console.error(`[OmniExporter] ExtractionByUuid error:`, error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Handle Thread List Fetching
 */
async function handleGetThreadList(adapter, payload, sendResponse) {
    try {
        const response = await adapter.getThreads(payload.page || 1, payload.limit || 20, payload.spaceId);
        sendResponse({ success: true, data: response });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Handle Thread List Fetching with Direct Offset (for Load All feature)
 * ENTERPRISE: Supports all 6 platforms with anti-bot measures
 */
async function handleGetThreadListOffset(adapter, payload, sendResponse) {
    try {
        const offset = payload.offset || 0;
        const limit = payload.limit || 50;

        // ANTI-BOT: Add random delay between requests (200-800ms)
        if (offset > 0) {
            const delay = 200 + Math.random() * 600;
            await new Promise(r => setTimeout(r, delay));
        }

        // Common headers to appear more like a real browser
        const browserHeaders = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };

        // Use Perplexity API directly with offset
        if (adapter.name === 'Perplexity') {
            const url = "https://www.perplexity.ai/rest/thread/list_ask_threads?version=2.18&source=default";
            const body = { limit, offset, ascending: false };

            const response = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: {
                    ...browserHeaders,
                    "content-type": "application/json"
                },
                body: JSON.stringify(body)
            });
            const data = await response.json();

            const threads = (Array.isArray(data) ? data : []).map(t => ({
                uuid: t.uuid,
                title: t.title || "Untitled",
                last_query_datetime: t.last_query_datetime
            }));

            sendResponse({ success: true, data: { threads, offset, hasMore: threads.length === limit } });
        }
        // ENTERPRISE: DeepSeek with cursor-based offset simulation
        else if (adapter.name === 'DeepSeek' && adapter.getThreadsWithOffset) {
            const result = await adapter.getThreadsWithOffset(offset, limit);
            sendResponse({
                success: true,
                data: {
                    threads: result.threads,
                    offset: result.offset,
                    hasMore: result.hasMore,
                    total: result.total
                }
            });
        }
        // ENTERPRISE: ChatGPT with native offset support + anti-bot headers
        else if (adapter.name === 'ChatGPT') {
            try {
                const baseUrl = 'https://chatgpt.com/backend-api';
                const url = `${baseUrl}/conversations?offset=${offset}&limit=${limit}&order=updated`;

                const response = await fetch(url, {
                    credentials: 'include',
                    headers: {
                        ...browserHeaders,
                        'Content-Type': 'application/json',
                        'OAI-Device-Id': localStorage.getItem('oai-device-id') || '',
                        'OAI-Language': 'en-US'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const threads = (data.items || []).map(t => ({
                        uuid: t.id,
                        title: t.title || 'ChatGPT Chat',
                        last_query_datetime: t.update_time
                    }));
                    sendResponse({
                        success: true,
                        data: { threads, offset, hasMore: threads.length === limit, total: data.total }
                    });
                } else if (response.status === 403 || response.status === 429) {
                    // Bot detection likely - use DOM fallback
                    console.warn('[ChatGPT] API blocked (403/429), using DOM fallback');
                    const result = await adapter.getThreads(1, limit);
                    sendResponse({ success: true, data: { threads: result.threads || result, offset: 0, hasMore: false } });
                } else {
                    // Other error - try page-based fallback
                    const page = Math.floor(offset / limit) + 1;
                    const result = await adapter.getThreads(page, limit);
                    sendResponse({ success: true, data: result });
                }
            } catch (e) {
                console.error('[ChatGPT] Error:', e.message);
                sendResponse({ success: false, error: e.message });
            }
        }
        // ENTERPRISE: Gemini with API support
        else if (adapter.name === 'Gemini') {
            try {
                const page = Math.floor(offset / limit) + 1;
                const result = await adapter.getThreads(page, limit);
                const threads = result.threads || result || [];
                sendResponse({
                    success: true,
                    data: {
                        threads: Array.isArray(threads) ? threads : [],
                        offset,
                        hasMore: result.hasMore || false
                    }
                });
            } catch (e) {
                console.warn('[Gemini] API failed, trying DOM fallback:', e.message);
                // DOM fallback - parse sidebar
                const threads = [];
                document.querySelectorAll('[class*="conversation-title"], [class*="chat-item"], a[href*="/app/"]').forEach((item, i) => {
                    if (i >= limit) return;
                    const href = item.closest('a')?.getAttribute('href') || '';
                    const uuid = href.match(/\/app\/([a-zA-Z0-9_-]+)/)?.[1];
                    if (uuid) {
                        threads.push({
                            uuid,
                            title: item.textContent?.trim() || 'Gemini Chat',
                            platform: 'Gemini'
                        });
                    }
                });
                sendResponse({ success: true, data: { threads, offset: 0, hasMore: false } });
            }
        }
        // ENTERPRISE: Grok support (NEW)
        else if (adapter.name === 'Grok') {
            try {
                const response = await fetch('https://grok.com/rest/app-chat/conversations', {
                    credentials: 'include',
                    headers: {
                        ...browserHeaders,
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const chats = data.conversations || data.data || data.items || [];
                    const threads = chats.slice(offset, offset + limit).map(t => ({
                        uuid: t.id || t.conversationId || t.uuid,
                        title: t.title || t.name || 'Grok Chat',
                        last_query_datetime: t.updatedAt || t.createdAt
                    }));
                    sendResponse({
                        success: true,
                        data: { threads, offset, hasMore: offset + limit < chats.length, total: chats.length }
                    });
                } else {
                    // DOM fallback
                    const result = await adapter.getThreads(1, limit);
                    sendResponse({ success: true, data: { threads: result, offset: 0, hasMore: false } });
                }
            } catch (e) {
                console.warn('[Grok] API failed:', e.message);
                const result = await adapter.getThreads(1, limit);
                sendResponse({ success: true, data: { threads: result, offset: 0, hasMore: false } });
            }
        }
        // ENTERPRISE: Use getAllThreads if adapter supports it (for complete Load All)
        else if (payload.loadAll && adapter.getAllThreads) {
            const threads = await adapter.getAllThreads();
            sendResponse({
                success: true,
                data: {
                    threads,
                    offset: 0,
                    hasMore: false,
                    total: threads.length
                }
            });
        }
        else {
            // Fallback to page-based for other platforms
            const page = Math.floor(offset / limit) + 1;
            const response = await adapter.getThreads(page, limit);
            sendResponse({ success: true, data: response });
        }
    } catch (error) {
        console.error('[handleGetThreadListOffset] Error:', error);
        sendResponse({ success: false, error: error.message });
    }
}



async function handleGetSpaces(adapter, sendResponse) {
    try {
        if (!adapter.getSpaces) return sendResponse({ success: true, data: [] });
        const spaces = await adapter.getSpaces();
        sendResponse({ success: true, data: spaces });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

// --- Platform Detection & Adapters (Fix #5: Capability Validation) ---

/**
 * Validate adapter has required methods
 */
function validateAdapter(adapter) {
    const required = ['name', 'extractUuid', 'getThreads', 'getThreadDetail'];
    for (const method of required) {
        if (!adapter[method]) {
            console.error(`[OmniExporter] Adapter missing required method: ${method}`);
            return false;
        }
    }
    return true;
}

function getPlatformAdapter() {
    const host = window.location.hostname;
    let adapter = null;

    // Original platforms (with platform-config.js)
    if (host.includes("perplexity.ai")) {
        adapter = PerplexityAdapter;
    }
    else if (host.includes("chatgpt.com") || host.includes("openai.com")) {
        adapter = ChatGPTAdapter;
    }
    else if (host.includes("claude.ai")) {
        adapter = ClaudeAdapter;
    }
    // New platforms (with standalone adapters)
    else if (host.includes("gemini.google.com")) {
        adapter = window.GeminiAdapter || null;
    }
    else if (host.includes("grok.com") || host.includes("x.com")) {
        adapter = window.GrokAdapter || null;
    }
    else if (host.includes("chat.deepseek.com") || host.includes("deepseek.com")) {
        adapter = window.DeepSeekAdapter || null;
    }

    // Validate adapter has required capabilities
    if (adapter && !validateAdapter(adapter)) {
        return null;
    }

    return adapter;
}

// --- Perplexity Implementation (Uses Platform Config) ---
const PerplexityAdapter = {
    name: "Perplexity",

    extractUuid: (url) => {
        // Use config layer with multiple pattern fallbacks
        return platformConfig.extractUuid('Perplexity', url);
    },

    getThreads: async (page, limit, spaceId = null) => {
        try {
            // Build endpoint using config
            const endpoint = platformConfig.buildEndpoint('Perplexity', 'listThreads');
            const baseUrl = platformConfig.getBaseUrl('Perplexity');
            const url = `${baseUrl}${endpoint}`;

            const body = { limit, offset: (page - 1) * limit, ascending: false };
            if (spaceId) body.collection_uuid = spaceId;

            const response = await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: { "accept": "*/*", "content-type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                // Mark endpoint as failed, will use fallback next time
                platformConfig.markEndpointFailed('Perplexity', 'listThreads');
                throw new Error(`API Error: ${response.status}`);
            }

            const data = await response.json();
            return {
                threads: (Array.isArray(data) ? data : []).map(t => ({
                    uuid: t.uuid,
                    title: DataExtractor.extractTitle(t, 'Perplexity'),
                    last_query_datetime: t.last_query_datetime
                })),
                hasMore: (data.length || 0) === limit,
                page
            };
        } catch (error) {
            console.error('[Perplexity] getThreads error:', error);
            throw error;
        }
    },

    getSpaces: async () => {
        try {
            const endpoint = platformConfig.buildEndpoint('Perplexity', 'spaces');
            const baseUrl = platformConfig.getBaseUrl('Perplexity');
            const response = await fetch(`${baseUrl}${endpoint}`, { credentials: "include" });

            if (!response.ok) {
                platformConfig.markEndpointFailed('Perplexity', 'spaces');
                return [];
            }

            const data = await response.json();
            return (data || []).map(s => ({ uuid: s.uuid, name: s.title }));
        } catch (error) {
            console.error('[Perplexity] getSpaces error:', error);
            return [];
        }
    },

    getThreadDetail: async (uuid) => {
        return await fetchPerplexityDetailResilient(uuid);
    }
};

// --- ChatGPT Implementation (Enterprise Edition - Matches Perplexity Quality) ---
const ChatGPTAdapter = {
    name: "ChatGPT",

    // Cache for pagination
    _allThreadsCache: [],
    _cacheTimestamp: 0,
    _cacheTTL: 60000, // 1 minute

    extractUuid: (url) => {
        return platformConfig.extractUuid('ChatGPT', url);
    },

    // ============================================
    // ENTERPRISE: Get anti-bot headers
    // ChatGPT uses OAI-Device-Id for bot detection
    // FIXED: Added more comprehensive header extraction
    // ============================================
    _getHeaders: () => {
        const headers = {
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/json',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': navigator.userAgent
        };

        // Get OAI headers from localStorage (set by ChatGPT)
        try {
            const deviceId = localStorage.getItem('oai-device-id');
            if (deviceId) {
                headers['OAI-Device-Id'] = deviceId;
                console.log('[ChatGPT] Using OAI-Device-Id:', deviceId.substring(0, 8) + '...');
            }
            
            // Try to get session token
            const sessionToken = localStorage.getItem('sessionToken') || 
                                localStorage.getItem('__Secure-next-auth.session-token');
            if (sessionToken) {
                console.log('[ChatGPT] Found session token');
            }
            
            headers['OAI-Language'] = 'en-US';
        } catch (e) {
            console.warn('[ChatGPT] Could not read localStorage:', e.message);
        }

        return headers;
    },

    // ============================================
    // ENTERPRISE: Retry with exponential backoff
    // ============================================
    _fetchWithRetry: async (url, options = {}, maxRetries = 3) => {
        let lastError;
        const headers = { ...ChatGPTAdapter._getHeaders(), ...options.headers };

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    headers,
                    ...options
                });

                if (response.ok) return response;

                if (response.status === 401 || response.status === 403) {
                    throw new Error('Authentication required - please login to ChatGPT');
                }

                if (response.status === 429) {
                    // Rate limited - wait longer
                    const waitTime = Math.pow(2, attempt + 2) * 1000;
                    console.warn(`[ChatGPT] Rate limited, waiting ${waitTime}ms`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }

                lastError = new Error(`HTTP ${response.status}`);
            } catch (e) {
                lastError = e;
            }

            if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
            }
        }
        throw lastError;
    },

    // ============================================
    // ENTERPRISE: Get ALL threads (Load All feature)
    // ============================================
    getAllThreads: async (progressCallback = null) => {
        const allThreads = [];
        let offset = 0;
        const limit = 50;
        const seenIds = new Set();

        try {
            do {
                const result = await ChatGPTAdapter.getThreadsWithOffset(offset, limit);

                result.threads.forEach(t => {
                    if (!seenIds.has(t.uuid)) {
                        seenIds.add(t.uuid);
                        allThreads.push(t);
                    }
                });

                if (progressCallback) {
                    progressCallback(allThreads.length, result.hasMore);
                }

                offset += limit;

                if (!result.hasMore) break;
                if (allThreads.length > 5000) break; // Safety limit

                await new Promise(r => setTimeout(r, 300)); // Rate limit

            } while (true);

            // Update cache
            ChatGPTAdapter._allThreadsCache = allThreads;
            ChatGPTAdapter._cacheTimestamp = Date.now();

            return allThreads;
        } catch (error) {
            console.error('[ChatGPT] getAllThreads failed:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Offset-based fetching
    // ============================================
    getThreadsWithOffset: async (offset = 0, limit = 50) => {
        // Check cache validity
        const cacheValid = ChatGPTAdapter._cacheTimestamp > Date.now() - ChatGPTAdapter._cacheTTL;

        if (cacheValid && ChatGPTAdapter._allThreadsCache.length > 0 && offset < ChatGPTAdapter._allThreadsCache.length) {
            const threads = ChatGPTAdapter._allThreadsCache.slice(offset, offset + limit);
            return {
                threads,
                offset,
                hasMore: offset + limit < ChatGPTAdapter._allThreadsCache.length,
                total: ChatGPTAdapter._allThreadsCache.length
            };
        }

        try {
            const baseUrl = platformConfig.getBaseUrl('ChatGPT');
            const endpoint = platformConfig.buildEndpoint('ChatGPT', 'conversations');
            const url = `${baseUrl}${endpoint}?offset=${offset}&limit=${limit}&order=updated`;

            const response = await ChatGPTAdapter._fetchWithRetry(url);
            const data = await response.json();

            const threads = (data.items || []).map(t => ({
                uuid: t.id,
                title: DataExtractor.extractTitle(t, 'ChatGPT'),
                last_query_datetime: t.update_time,
                platform: 'ChatGPT'
            }));

            return {
                threads,
                offset,
                hasMore: data.has_missing_conversations || threads.length === limit,
                total: data.total || -1
            };
        } catch (error) {
            console.error('[ChatGPT] getThreadsWithOffset error:', error);
            throw error;
        }
    },

    // Standard page-based (backwards compatible)
    getThreads: async (page, limit) => {
        try {
            // Check NetworkInterceptor first
            if (window.NetworkInterceptor && window.NetworkInterceptor.getChatList().length > 0) {
                const all = window.NetworkInterceptor.getChatList();
                const start = (page - 1) * limit;
                return {
                    threads: all.slice(start, start + limit),
                    hasMore: start + limit < all.length,
                    page
                };
            }

            const offset = (page - 1) * limit;
            const result = await ChatGPTAdapter.getThreadsWithOffset(offset, limit);

            return {
                threads: result.threads,
                hasMore: result.hasMore,
                page
            };
        } catch (error) {
            console.error('[ChatGPT] getThreads error:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Resilient thread detail fetching
    // FIXED: Added multiple endpoint fallbacks and better error handling
    // ============================================
    getThreadDetail: async (uuid) => {
        // Strategy 1: API fetch with retry (multiple endpoint attempts)
        const endpoints = [
            `/backend-api/conversation/${uuid}`,
            `/api/conversation/${uuid}`,
            `/backend-api/conversations/${uuid}`
        ];

        for (const endpoint of endpoints) {
            try {
                const baseUrl = platformConfig.getBaseUrl('ChatGPT');
                const url = `${baseUrl}${endpoint}`;
                console.log(`[ChatGPT] Trying endpoint: ${endpoint}`);

                const response = await ChatGPTAdapter._fetchWithRetry(url, {}, 2);
                const data = await response.json();
                
                // Validate response structure
                if (!data || (!data.mapping && !data.messages && !data.conversation)) {
                    console.warn('[ChatGPT] Invalid response structure from:', endpoint);
                    continue;
                }

                const entries = transformChatGPTData(data);

                if (entries.length > 0) {
                    console.log(`[ChatGPT] ✓ API success: ${entries.length} entries for ${uuid}`);
                    return { uuid, entries, title: data.title || 'ChatGPT Chat', platform: 'ChatGPT' };
                }
            } catch (error) {
                console.warn(`[ChatGPT] Endpoint ${endpoint} failed:`, error.message);
                continue;
            }
        }

        // Strategy 2: Check if this is the current conversation
        const isCurrentConversation = window.location.href.includes(uuid);
        if (isCurrentConversation) {
            console.log('[ChatGPT] Falling back to DOM extraction for current conversation');
            return ChatGPTAdapter.extractFromDOM(uuid);
        }

        // Strategy 3: Return helpful error
        console.error('[ChatGPT] All API endpoints failed for conversation:', uuid);
        return {
            uuid,
            title: 'Unable to fetch - API error',
            platform: 'ChatGPT',
            entries: [],
            error: 'All API endpoints failed. Try opening the conversation in your browser first, then export again.'
        };
    },

    /**
     * Extract messages from DOM when API fails
     * FIXED: Updated selectors for latest ChatGPT UI (2024+)
     */
    extractFromDOM: (uuid) => {
        console.log('[ChatGPT] Starting DOM extraction...');
        const messages = [];

        // Strategy 1: Modern ChatGPT UI - data-message-author-role attribute
        const messageContainers = document.querySelectorAll('[data-message-author-role]');
        if (messageContainers.length > 0) {
            console.log(`[ChatGPT] Strategy 1: Found ${messageContainers.length} messages with data-message-author-role`);

            let currentQuery = '';
            messageContainers.forEach(container => {
                const role = container.getAttribute('data-message-author-role');
                const text = container.innerText?.trim() || '';

                if (text.length > 5) {
                    if (role === 'user') {
                        currentQuery = text;
                    } else if (role === 'assistant' && currentQuery) {
                        messages.push({ query: currentQuery, answer: text });
                        currentQuery = '';
                    }
                }
            });
        }

        // Strategy 2: Article elements with role detection
        if (messages.length === 0) {
            const articles = document.querySelectorAll('article, [data-testid*="conversation-turn"]');
            console.log(`[ChatGPT] Strategy 2: Found ${articles.length} articles`);

            let currentQuery = '';
            articles.forEach((article) => {
                const text = article.innerText?.trim() || '';
                if (text.length < 10) return;

                // Check for role indicators in parent or article itself
                const isUser = article.closest('[data-message-author-role="user"]') ||
                              article.querySelector('[data-message-author-role="user"]') ||
                              text.toLowerCase().includes('you said');
                
                if (isUser) {
                    currentQuery = text;
                } else if (currentQuery) {
                    messages.push({ query: currentQuery, answer: text });
                    currentQuery = '';
                }
            });
        }

        // Strategy 3: Alternating message blocks (fallback)
        if (messages.length === 0) {
            console.log('[ChatGPT] Strategy 3: Alternating blocks');
            
            const allBlocks = Array.from(document.querySelectorAll('main [class*="group"], main > div > div > div'));
            const textBlocks = [];
            
            allBlocks.forEach(block => {
                const text = block.innerText?.trim();
                if (text && text.length > 20) {
                    // Avoid duplicates
                    if (!textBlocks.includes(text)) {
                        textBlocks.push(text);
                    }
                }
            });

            // Pair them alternately (user, assistant, user, assistant...)
            for (let i = 0; i < textBlocks.length - 1; i += 2) {
                if (textBlocks[i] && textBlocks[i + 1]) {
                    messages.push({
                        query: textBlocks[i],
                        answer: textBlocks[i + 1]
                    });
                }
            }
        }

        console.log(`[ChatGPT] ✓ DOM extraction complete: ${messages.length} message pairs`);

        // Extract title from multiple sources
        const title = document.title?.replace(' | ChatGPT', '').replace(' - ChatGPT', '').trim() ||
            document.querySelector('h1')?.textContent?.trim() ||
            document.querySelector('[class*="conversation-title"]')?.textContent?.trim() ||
            messages[0]?.query?.substring(0, 100) ||
            'ChatGPT Conversation';

        return {
            uuid: uuid,
            title: title,
            platform: 'ChatGPT',
            entries: messages.filter(m => m.query?.trim() && m.answer?.trim())
        };
    },

    getSpaces: async () => []
};

// --- Claude Implementation (Enterprise Edition - Matches Perplexity Quality) ---
const ClaudeAdapter = {
    name: "Claude",
    _cachedOrgId: null,

    // Cache for pagination
    _allThreadsCache: [],
    _cacheTimestamp: 0,
    _cacheTTL: 60000, // 1 minute

    extractUuid: (url) => {
        return platformConfig.extractUuid('Claude', url);
    },

    // ============================================
    // ENTERPRISE: Anti-bot headers
    // ============================================
    _getHeaders: () => {
        return {
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/json',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };
    },

    // ============================================
    // ENTERPRISE: Retry with exponential backoff
    // ============================================
    _fetchWithRetry: async (url, options = {}, maxRetries = 3) => {
        let lastError;
        const headers = { ...ClaudeAdapter._getHeaders(), ...options.headers };

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    headers,
                    ...options
                });

                if (response.ok) return response;

                if (response.status === 401 || response.status === 403) {
                    throw new Error('Authentication required - please login to Claude');
                }

                if (response.status === 429) {
                    const waitTime = Math.pow(2, attempt + 2) * 1000;
                    console.warn(`[Claude] Rate limited, waiting ${waitTime}ms`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }

                lastError = new Error(`HTTP ${response.status}`);
            } catch (e) {
                lastError = e;
            }

            if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
            }
        }
        throw lastError;
    },

    async getOrgId() {
        if (this._cachedOrgId) return this._cachedOrgId;

        try {
            const baseUrl = platformConfig.getBaseUrl('Claude');
            const endpoint = platformConfig.buildEndpoint('Claude', 'organizations');
            const response = await ClaudeAdapter._fetchWithRetry(`${baseUrl}${endpoint}`);

            const orgs = await response.json();
            if (!orgs || orgs.length === 0) {
                throw new Error('No Claude organizations found. Please check your login.');
            }

            this._cachedOrgId = orgs[0].uuid;
            console.log(`[Claude] Org found: ${orgs[0].name || this._cachedOrgId}`);
            return this._cachedOrgId;
        } catch (error) {
            console.error('[Claude] org fetch failed:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Get ALL threads (Load All feature)
    // ============================================
    getAllThreads: async function (progressCallback = null) {
        try {
            const orgId = await this.getOrgId();
            const baseUrl = platformConfig.getBaseUrl('Claude');
            const endpoint = platformConfig.buildEndpoint('Claude', 'conversations', { org: orgId });
            const response = await ClaudeAdapter._fetchWithRetry(`${baseUrl}${endpoint}`);

            const data = await response.json();
            const threads = (Array.isArray(data) ? data : []).map(t => ({
                uuid: t.uuid,
                title: DataExtractor.extractTitle(t, 'Claude'),
                last_query_datetime: t.updated_at,
                platform: 'Claude'
            }));

            // Update cache
            ClaudeAdapter._allThreadsCache = threads;
            ClaudeAdapter._cacheTimestamp = Date.now();

            if (progressCallback) {
                progressCallback(threads.length, false);
            }

            return threads;
        } catch (error) {
            console.error('[Claude] getAllThreads failed:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Offset-based fetching
    // ============================================
    getThreadsWithOffset: async function (offset = 0, limit = 50) {
        // Check cache validity
        const cacheValid = ClaudeAdapter._cacheTimestamp > Date.now() - ClaudeAdapter._cacheTTL;

        if (!cacheValid || ClaudeAdapter._allThreadsCache.length === 0) {
            await ClaudeAdapter.getAllThreads();
        }

        const threads = ClaudeAdapter._allThreadsCache.slice(offset, offset + limit);
        return {
            threads,
            offset,
            hasMore: offset + limit < ClaudeAdapter._allThreadsCache.length,
            total: ClaudeAdapter._allThreadsCache.length
        };
    },

    // Standard page-based (backwards compatible)
    getThreads: async function (page, limit) {
        try {
            const result = await this.getThreadsWithOffset((page - 1) * limit, limit);

            return {
                threads: result.threads,
                hasMore: result.hasMore,
                page
            };
        } catch (error) {
            console.error('[Claude] getThreads error:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Resilient thread detail fetching
    // ============================================
    getThreadDetail: async function (uuid) {
        try {
            const orgId = await this.getOrgId();
            const baseUrl = platformConfig.getBaseUrl('Claude');
            const endpoint = platformConfig.buildEndpoint('Claude', 'conversationDetail', { org: orgId, uuid });
            const url = `${baseUrl}${endpoint}`;

            const response = await ClaudeAdapter._fetchWithRetry(url);
            const data = await response.json();

            console.log(`[Claude] API success for ${uuid}`);
            return {
                uuid,
                entries: transformClaudeData(data),
                title: data.name,
                platform: 'Claude'
            };
        } catch (error) {
            console.error('[Claude] getThreadDetail error:', error);

            // Check if this is the current conversation
            const isCurrentConversation = window.location.href.includes(uuid);
            if (isCurrentConversation) {
                console.log('[Claude] Falling back to DOM extraction');
                return ClaudeAdapter.extractFromDOM(uuid);
            }

            return {
                uuid,
                title: 'Unable to fetch - API error',
                platform: 'Claude',
                entries: [],
                error: 'API access failed - can only export current conversation'
            };
        }
    },

    extractFromDOM: (uuid) => {
        console.log('[Claude] Starting DOM extraction...');
        const messages = [];

        // Strategy 1: Human/assistant message pairs
        const humanMessages = document.querySelectorAll('[class*="human-turn"], [data-testid="human-turn"]');
        const assistantMessages = document.querySelectorAll('[class*="assistant-turn"], [data-testid="assistant-turn"]');

        if (humanMessages.length > 0 || assistantMessages.length > 0) {
            const max = Math.max(humanMessages.length, assistantMessages.length);
            for (let i = 0; i < max; i++) {
                messages.push({
                    query: humanMessages[i]?.innerText?.trim() || '',
                    answer: assistantMessages[i]?.innerText?.trim() || ''
                });
            }
        }

        // Strategy 2: Prose/markdown containers
        if (messages.length === 0) {
            const proseBlocks = document.querySelectorAll('.prose, [class*="markdown"]');
            let currentQuery = '';
            proseBlocks.forEach((block, i) => {
                const text = block.innerText?.trim() || '';
                if (text.length > 10) {
                    if (i % 2 === 0) {
                        currentQuery = text;
                    } else {
                        messages.push({ query: currentQuery, answer: text });
                        currentQuery = '';
                    }
                }
            });
        }

        const title = document.title?.replace(' — Claude', '').replace(' - Claude', '').trim() || 'Claude Conversation';
        return { uuid, title, platform: 'Claude', entries: messages.filter(m => m.query || m.answer) };
    },

    getSpaces: async () => []
};

// --- Helper Functions ---

/**
 * Resilient Perplexity detail fetcher using platform config
 */
async function fetchPerplexityDetailResilient(uuid) {
    console.log('[Perplexity] Fetching thread detail for:', uuid);

    let entries = [];
    let cursor = null;
    let isInitial = true;
    let title = 'Untitled Thread';

    // Get version from config or detector
    const version = platformConfig.activeVersions.get('Perplexity') ||
        PLATFORM_CONFIGS.Perplexity.versions.current;

    try {
        while (true) {
            // Build endpoint using config
            const baseUrl = platformConfig.getBaseUrl('Perplexity');
            const params = new URLSearchParams({
                with_parent_info: "true",
                with_schematized_response: "true",
                version: version,
                source: "default",
                limit: isInitial ? "10" : "100"
            });
            if (cursor) params.append("cursor", cursor);

            const url = `${baseUrl}/rest/thread/${uuid}?${params.toString()}`;
            console.log('[OmniExporter] Fetching:', url);

            const response = await fetch(url, {
                credentials: "include",
                headers: {
                    "x-app-apiversion": "2.18",
                    "accept": "application/json"
                }
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            const json = await response.json();
            console.log('[OmniExporter] API Response:', json);

            // Extract entries - filter duplicates
            if (json.entries && Array.isArray(json.entries)) {
                json.entries.forEach(entry => {
                    if (!entries.find(e => e.uuid === entry.uuid)) {
                        entries.push(entry);
                    }
                });
            }

            // Extract title from first entry if available
            if (entries.length > 0 && !title || title === 'Untitled Thread') {
                const firstEntry = entries[0];
                if (firstEntry.query_str) {
                    title = firstEntry.query_str.slice(0, 100);
                }
            }

            // Check for pagination
            if (!json.next_cursor || json.next_cursor === cursor) {
                console.log('[OmniExporter] No more pages, total entries:', entries.length);
                break;
            }

            cursor = json.next_cursor;
            isInitial = false;
        }

        console.log('[OmniExporter] Final result - Title:', title, 'Entries:', entries.length);

        // Debug: Log first entry structure
        if (entries.length > 0) {
            console.log('[OmniExporter] First entry structure:', JSON.stringify(entries[0], null, 2).slice(0, 500));
        }

        return {
            entries: entries,
            title: title,
            uuid: uuid
        };
    } catch (error) {
        console.error('[OmniExporter] Error fetching thread detail:', error);
        throw error;
    }
}


function transformChatGPTData(data) {
    // ChatGPT returns a tree structure with mapping object.
    // We need to traverse from root to leaves to get ordered messages.
    const entries = [];
    const mapping = data.mapping || {};

    try {
        // Find the root node (node with no parent or parent is null)
        let currentNodeId = null;

        // Method 1: Find root node with null parent
        for (const [id, node] of Object.entries(mapping)) {
            if (!node.parent) {
                currentNodeId = id;
                break;
            }
        }

        // Method 2: If no root found, use first node
        if (!currentNodeId && Object.keys(mapping).length > 0) {
            currentNodeId = Object.keys(mapping)[0];
        }

        // Traverse the tree following children links
        const orderedMessages = [];
        const visited = new Set();

        while (currentNodeId && !visited.has(currentNodeId)) {
            visited.add(currentNodeId);
            const node = mapping[currentNodeId];

            if (node?.message) {
                const msg = node.message;
                const role = msg.author?.role;

                // Extract content - ChatGPT uses various content structures
                let content = '';

                if (msg.content?.parts && Array.isArray(msg.content.parts)) {
                    content = msg.content.parts
                        .filter(p => typeof p === 'string')
                        .join('\n');
                } else if (msg.content?.text) {
                    content = msg.content.text;
                } else if (typeof msg.content === 'string') {
                    content = msg.content;
                }

                // Skip system messages and empty content
                if (role && role !== 'system' && content.trim()) {
                    orderedMessages.push({
                        role: role,
                        content: content.trim(),
                        create_time: msg.create_time,
                        id: msg.id
                    });
                }
            }

            // Move to first child (follow the conversation thread)
            if (node?.children && node.children.length > 0) {
                currentNodeId = node.children[0];
            } else {
                break;
            }
        }

        // If tree traversal didn't work, fallback to sorting all messages
        if (orderedMessages.length === 0) {
            Object.values(mapping).forEach(node => {
                const msg = node?.message;
                if (msg && msg.author?.role && msg.author.role !== 'system') {
                    let content = '';
                    if (msg.content?.parts && Array.isArray(msg.content.parts)) {
                        content = msg.content.parts.filter(p => typeof p === 'string').join('\n');
                    } else if (msg.content?.text) {
                        content = msg.content.text;
                    }
                    if (content.trim()) {
                        orderedMessages.push({
                            role: msg.author.role,
                            content: content.trim(),
                            create_time: msg.create_time || 0
                        });
                    }
                }
            });
            // Sort by create_time
            orderedMessages.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
        }

        // Pair user questions with assistant answers
        let currentEntry = null;
        orderedMessages.forEach(msg => {
            if (msg.role === 'user') {
                // Push previous entry if exists
                if (currentEntry && currentEntry.blocks.length > 0) {
                    entries.push(currentEntry);
                }
                currentEntry = {
                    query_str: msg.content,
                    blocks: []
                };
            } else if ((msg.role === 'assistant' || msg.role === 'tool') && currentEntry) {
                currentEntry.blocks.push({
                    intended_usage: 'ask_text',
                    markdown_block: { answer: msg.content }
                });
            }
        });

        // Push final entry
        if (currentEntry && currentEntry.blocks.length > 0) {
            entries.push(currentEntry);
        }

        console.log(`[ChatGPT] Transformed ${orderedMessages.length} messages into ${entries.length} entries`);
    } catch (e) {
        console.error('[OmniExporter] ChatGPT transform error:', e);
    }

    return entries;
}

function transformClaudeData(data) {
    // Claude returns chat_messages array
    const entries = [];
    const messages = data.chat_messages || [];

    try {
        let currentEntry = null;
        messages.forEach(msg => {
            if (msg.sender === 'human') {
                if (currentEntry) entries.push(currentEntry);
                currentEntry = {
                    query_str: msg.text || '',
                    blocks: []
                };
            } else if (msg.sender === 'assistant' && currentEntry) {
                currentEntry.blocks.push({
                    intended_usage: 'ask_text',
                    markdown_block: { answer: msg.text || '' }
                });
            }
        });
        if (currentEntry && currentEntry.blocks.length > 0) {
            entries.push(currentEntry);
        }
    } catch (e) {
        console.error('[OmniExporter] Claude transform error:', e);
    }

    return entries;
}

// ============================================
// RESILIENT EXTRACTION HELPERS
// ============================================

/**
 * Extract answer using DataExtractor with fallbacks
 */
function extractAnswerResilient(entry, platform) {
    // Try DataExtractor first (uses config-based paths)
    const extracted = DataExtractor.extractAnswer(entry, platform);
    if (extracted) return extracted;

    // Fallback: Try Perplexity block extraction
    if (platform === 'Perplexity' && entry.blocks) {
        const { answer } = DataExtractor.extractFromPerplexityBlocks(entry);
        if (answer) return answer;
    }

    // Final fallback: direct properties
    return entry.answer || entry.text || entry.content || '';
}

/**
 * Extract query using DataExtractor with fallbacks
 */
function extractQueryResilient(entry, platform) {
    const extracted = DataExtractor.extractQuery(entry, platform);
    if (extracted) return extracted;

    // Fallback
    return entry.query || entry.query_str || entry.question || '';
}

// ============================================
// AUTO-VERSION DETECTION ON LOAD
// ============================================
async function initializePlatformAdapters() {
    try {
        const adapter = getPlatformAdapter();
        if (adapter) {
            const detectedVersion = await versionDetector.detect(adapter.name);
            platformConfig.setActiveVersion(adapter.name, detectedVersion);
            console.log(`[OmniExporter] Detected ${adapter.name} version: ${detectedVersion}`);
        }
    } catch (e) {
        console.warn('[OmniExporter] Version detection failed:', e);
    }
}

// Initialize version detection after DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePlatformAdapters);
} else {
    initializePlatformAdapters();
}

// ============================================
// INITIALIZE CONTENT SCRIPT MANAGER
// ============================================
const contentManager = new ContentScriptManager();
contentManager.initialize();

