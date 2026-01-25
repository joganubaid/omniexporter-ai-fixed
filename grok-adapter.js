// OmniExporter AI - Grok Adapter (Enterprise Edition)
// Support for xAI Grok (grok.com and x.com/i/grok)
// Enterprise-level matching Perplexity quality
// NOW USES: platformConfig for centralized configuration

const GrokAdapter = {
    name: "Grok",

    // ============================================
    // ENTERPRISE: Use platformConfig for endpoints
    // ============================================
    get config() {
        return typeof platformConfig !== 'undefined'
            ? platformConfig.getConfig('Grok')
            : null;
    },

    get apiBase() {
        const config = this.config;
        return config ? config.baseUrl + '/rest/app-chat' : 'https://grok.com/rest/app-chat';
    },

    // Cache for pagination
    _allThreadsCache: [],
    _cacheTimestamp: 0,
    _cacheTTL: 60000, // 1 minute

    extractUuid: (url) => {
        // Try platformConfig patterns first
        if (typeof platformConfig !== 'undefined') {
            const uuid = platformConfig.extractUuid('Grok', url);
            if (uuid) return uuid;
        }

        // Fallback patterns
        const uuidMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (uuidMatch) return uuidMatch[1];

        const chatMatch = url.match(/grok\.com\/(?:chat|c)\/([a-zA-Z0-9_-]+)/);
        if (chatMatch) return chatMatch[1];

        const xMatch = url.match(/x\.com\/i\/grok\/([a-zA-Z0-9_-]+)/);
        if (xMatch) return xMatch[1];

        return null;
    },

    // ============================================
    // ENTERPRISE: Anti-bot headers
    // ============================================
    _getHeaders: () => {
        return {
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'X-Requested-With': 'XMLHttpRequest'
        };
    },

    // ============================================
    // ENTERPRISE: Retry with exponential backoff
    // ============================================
    _fetchWithRetry: async (url, options = {}, maxRetries = 3) => {
        let lastError;
        const headers = { ...GrokAdapter._getHeaders(), ...options.headers };

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    headers,
                    ...options
                });

                if (response.ok) return response;

                if (response.status === 401 || response.status === 403) {
                    throw new Error('Authentication required - please login to Grok');
                }

                if (response.status === 429) {
                    const waitTime = Math.pow(2, attempt + 2) * 1000;
                    console.warn(`[Grok] Rate limited, waiting ${waitTime}ms`);
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
        try {
            const response = await GrokAdapter._fetchWithRetry(`${GrokAdapter.apiBase}/conversations`);
            const data = await response.json();
            const chats = data.conversations || data.data || data.items || [];

            const threads = chats.map(chat => ({
                uuid: chat.id || chat.conversationId || chat.uuid,
                title: chat.title || chat.name || 'Grok Chat',
                platform: 'Grok',
                last_query_datetime: chat.updatedAt || chat.createdAt || new Date().toISOString()
            }));

            // Update cache
            GrokAdapter._allThreadsCache = threads;
            GrokAdapter._cacheTimestamp = Date.now();

            if (progressCallback) {
                progressCallback(threads.length, false);
            }

            return threads;
        } catch (error) {
            console.error('[Grok] getAllThreads failed:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Offset-based fetching
    // ============================================
    getThreadsWithOffset: async (offset = 0, limit = 50) => {
        // Check cache validity
        const cacheValid = GrokAdapter._cacheTimestamp > Date.now() - GrokAdapter._cacheTTL;

        if (!cacheValid || GrokAdapter._allThreadsCache.length === 0) {
            await GrokAdapter.getAllThreads();
        }

        const threads = GrokAdapter._allThreadsCache.slice(offset, offset + limit);
        return {
            threads,
            offset,
            hasMore: offset + limit < GrokAdapter._allThreadsCache.length,
            total: GrokAdapter._allThreadsCache.length
        };
    },

    // Standard page-based (backwards compatible)
    getThreads: async (page = 0, limit = 50) => {
        // Check NetworkInterceptor first
        if (window.NetworkInterceptor && window.NetworkInterceptor.getChatList().length > 0) {
            const all = window.NetworkInterceptor.getChatList();
            const start = page * limit;
            return {
                threads: all.slice(start, start + limit),
                hasMore: start + limit < all.length,
                page
            };
        }

        try {
            const result = await GrokAdapter.getThreadsWithOffset(page * limit, limit);
            return {
                threads: result.threads,
                hasMore: result.hasMore,
                page
            };
        } catch (e) {
            console.error('[Grok] API fetch failed:', e);
            throw e;
        }
    },

    // ============================================
    // ENTERPRISE: Resilient thread detail fetching
    // ============================================
    getThreadDetail: async (uuid) => {
        const isCurrentConversation = window.location.href.includes(uuid);

        // Try multiple API endpoints (Grok changes their API frequently)
        const endpoints = [
            `${GrokAdapter.apiBase}/conversations_v2/${uuid}?includeWorkspaces=true&includeTaskResult=true`,
            `${GrokAdapter.apiBase}/conversation/${uuid}`,
            `https://grok.com/rest/app-chat/conversation/${uuid}`,
            `https://grok.com/api/conversation/${uuid}`
        ];

        for (const endpoint of endpoints) {
            try {
                console.log('[Grok] Trying API:', endpoint);
                const response = await GrokAdapter._fetchWithRetry(endpoint, {}, 2);
                const data = await response.json();

                const messages = data.messages || data.conversation?.messages ||
                    data.data?.messages || data.turns || data.items || [];

                if (Array.isArray(messages) && messages.length > 0) {
                    const entries = [];
                    let currentQuery = '';

                    messages.forEach(msg => {
                        const role = (msg.role || msg.sender || msg.author || msg.type || '').toLowerCase();
                        const content = msg.content || msg.text || msg.message ||
                            (msg.parts ? msg.parts.join('\n') : '');

                        if (role === 'user' || role === 'human') {
                            currentQuery = content;
                        } else if ((role === 'assistant' || role === 'grok' || role === 'bot' || role === 'ai') && currentQuery) {
                            entries.push({ query: currentQuery, answer: content });
                            currentQuery = '';
                        }
                    });

                    // Handle unpaired last message
                    if (currentQuery && messages.length > 0) {
                        const lastMsg = messages[messages.length - 1];
                        const lastContent = lastMsg.content || lastMsg.text || '';
                        if (lastContent && lastContent !== currentQuery) {
                            entries.push({ query: currentQuery, answer: lastContent });
                        }
                    }

                    const title = data.title || data.conversation?.title || data.name || 'Grok Conversation';
                    console.log(`[Grok] API success: ${entries.length} entries for ${uuid}`);
                    return { uuid, title, platform: 'Grok', entries };
                }
            } catch (e) {
                console.warn('[Grok] API failed for', endpoint, ':', e.message);
                continue;
            }
        }

        console.error('[Grok] Cannot fetch conversation', uuid);
        throw new Error('All Grok API endpoints failed');
    },



    getSpaces: async () => []
};

window.GrokAdapter = GrokAdapter;
