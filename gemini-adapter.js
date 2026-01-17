// OmniExporter AI - Gemini Adapter (Enterprise Edition)
// Support for Google Gemini (gemini.google.com)
// VERIFIED API: batchexecute with rpcids MaZiqc (list) and hNvQHb (messages)
// Discovered via Chrome DevTools MCP 2026-01-10
// FIXED: XHR interceptor now runs in PAGE context (not content script)

// =============================================
// PAGE CONTEXT SCRIPT INJECTOR
// Content scripts run in isolated world - they CAN'T intercept page XHRs
// Solution: Inject script into page context via web_accessible_resources
// =============================================

(function injectPageInterceptor() {
    // Only run on Gemini pages
    if (!window.location.hostname.includes('gemini.google.com')) return;

    // Prevent duplicate injection
    if (document.getElementById('omni-gemini-interceptor')) return;

    try {
        const script = document.createElement('script');
        script.id = 'omni-gemini-interceptor';
        script.src = chrome.runtime.getURL('gemini-page-interceptor.js');
        script.onload = function () {
            console.log('[GeminiAdapter] Page interceptor injected successfully');
            this.remove(); // Clean up script tag after execution
        };
        script.onerror = function () {
            console.warn('[GeminiAdapter] Failed to inject page interceptor');
        };
        (document.head || document.documentElement).appendChild(script);
    } catch (e) {
        console.warn('[GeminiAdapter] Injection error:', e.message);
    }
})();

// =============================================
// MESSAGE BRIDGE - Connect to gemini-inject.js
// Listens for messages from page context scripts
// =============================================
const GeminiBridge = {
    pendingRequests: new Map(),
    isReady: false,
    interceptorReady: false,

    init() {
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            if (!event.data || event.data.type !== 'OMNIEXPORTER_GEMINI') return;
            if (event.data.direction !== 'to-content') return;

            this.handleMessage(event.data);
        });
        console.log('[GeminiAdapter] Message bridge initialized');
    },

    handleMessage(message) {
        const { action, requestId, success, data, error } = message;

        switch (action) {
            case 'INJECT_READY':
                this.isReady = true;
                console.log('[GeminiAdapter] gemini-inject.js is ready');
                break;
            case 'INTERCEPTOR_READY':
                this.interceptorReady = true;
                console.log('[GeminiAdapter] Page interceptor ready - limit:', data?.limit);
                break;
            case 'RESPONSE':
                const pending = this.pendingRequests.get(requestId);
                if (pending) {
                    this.pendingRequests.delete(requestId);
                    if (success) {
                        pending.resolve(data);
                    } else {
                        pending.reject(new Error(error || 'Unknown error'));
                    }
                }
                break;
        }
    },

    // Send request to page context (gemini-inject.js)
    sendRequest(action, data = {}) {
        return new Promise((resolve, reject) => {
            const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            this.pendingRequests.set(requestId, { resolve, reject });

            // Timeout after 10 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 10000);

            window.postMessage({
                type: 'OMNIEXPORTER_GEMINI',
                direction: 'to-page',
                requestId,
                action,
                data
            }, '*');
        });
    },

    // Get auth token from page context
    async getAuthToken() {
        if (!this.isReady) return null;
        try {
            const result = await this.sendRequest('GET_AUTH_TOKEN');
            return result?.token || result?.SNlM0e || null;
        } catch {
            return null;
        }
    },

    // Get global data from page context  
    async getGlobalData() {
        if (!this.isReady) return null;
        try {
            return await this.sendRequest('GET_GLOBAL_DATA');
        } catch {
            return null;
        }
    }
};

// Initialize bridge
GeminiBridge.init();

const GeminiAdapter = {
    name: "Gemini",

    // ============================================
    // ENTERPRISE: Use platformConfig for endpoints
    // ============================================
    get config() {
        return typeof platformConfig !== 'undefined'
            ? platformConfig.getConfig('Gemini')
            : null;
    },

    get apiBase() {
        const config = this.config;
        return config ? config.baseUrl + '/_/BardChatUi/data/batchexecute' : 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
    },

    // Cache for pagination cursors
    _cursorCache: [],
    _allThreadsCache: [],
    _cacheTimestamp: 0,
    _cacheTTL: 60000,

    extractUuid: (url) => {
        // Try platformConfig patterns first
        if (typeof platformConfig !== 'undefined') {
            const uuid = platformConfig.extractUuid('Gemini', url);
            if (uuid) return uuid;
        }

        // Fallback patterns
        const appMatch = url.match(/gemini\.google\.com\/app\/([a-zA-Z0-9_-]+)/);
        if (appMatch) return appMatch[1];
        const gemMatch = url.match(/gemini\.google\.com\/gem\/([a-zA-Z0-9_-]+)/);
        if (gemMatch) return gemMatch[1];
        return 'gemini_' + Date.now();
    },

    // ============================================
    // ENTERPRISE: Anti-bot headers
    // ============================================
    _getHeaders: () => {
        return {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };
    },

    // ============================================
    // ENTERPRISE: Get ALL threads (Load All feature)
    // ============================================
    getAllThreads: async function (progressCallback = null) {
        try {
            const result = await this.getThreads(1, 100);

            // Update cache
            GeminiAdapter._allThreadsCache = result.threads;
            GeminiAdapter._cacheTimestamp = Date.now();

            if (progressCallback) {
                progressCallback(result.threads.length, false);
            }

            return result.threads;
        } catch (error) {
            console.error('[Gemini] getAllThreads failed:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Offset-based fetching
    // ============================================
    getThreadsWithOffset: async function (offset = 0, limit = 50) {
        // Check cache validity
        const cacheValid = GeminiAdapter._cacheTimestamp > Date.now() - GeminiAdapter._cacheTTL;

        if (!cacheValid || GeminiAdapter._allThreadsCache.length === 0) {
            await GeminiAdapter.getAllThreads();
        }

        const threads = GeminiAdapter._allThreadsCache.slice(offset, offset + limit);
        return {
            threads,
            offset,
            hasMore: offset + limit < GeminiAdapter._allThreadsCache.length,
            total: GeminiAdapter._allThreadsCache.length
        };
    },

    // ============================================
    // ENTERPRISE: Build batchexecute request
    // ============================================
    _buildBatchRequest: (rpcid, payload) => {
        const reqData = JSON.stringify([[rpcid, JSON.stringify(payload), null, "generic"]]);
        return `f.req=${encodeURIComponent(reqData)}&`;
    },

    // ============================================
    // ENTERPRISE: Make batchexecute API call
    // FIXED: Better error handling and response parsing
    // ============================================
    _batchExecute: async (rpcid, payload) => {
        const body = GeminiAdapter._buildBatchRequest(rpcid, payload);

        try {
            const response = await fetch(`${GeminiAdapter.apiBase}?rpcids=${rpcid}&source-path=/app&bl=boq_assistant-bard-web-server`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'Accept': '*/*',
                    'User-Agent': navigator.userAgent
                },
                body
            });

            if (!response.ok) {
                console.error(`[Gemini] API error: ${response.status} ${response.statusText}`);
                throw new Error(`Gemini API error: ${response.status}`);
            }

            const text = await response.text();
            console.log(`[Gemini] Raw response length: ${text.length} chars`);
            
            // Parse Google's weird response format (starts with ")]}'")
            const cleaned = text.replace(/^\)\]\}'/, '').trim();

            // Find and parse the JSON array in the response
            const lines = cleaned.split('\n');
            for (const line of lines) {
                if (line.startsWith('[')) {
                    try {
                        const parsed = JSON.parse(line);
                        console.log('[Gemini] ✓ Successfully parsed batchexecute response');
                        return parsed;
                    } catch (e) {
                        console.warn('[Gemini] Failed to parse line:', line.substring(0, 100));
                    }
                }
            }

            console.warn('[Gemini] No valid JSON found in response');
            return null;
        } catch (error) {
            console.error('[Gemini] _batchExecute failed:', error.message);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Get thread list via API
    // ============================================
    getThreads: async function (page = 1, limit = 20, cursor = null) {
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

        const threads = [];

        // Try API: rpcid MaZiqc for listing conversations
        try {
            // Payload: [limit, cursor, [0, null, 1]]
            const payload = [limit, cursor, [0, null, 1]];
            const response = await GeminiAdapter._batchExecute('MaZiqc', payload);

            if (response) {
                // Parse the nested response to extract conversations
                // Response is deeply nested, usually at response[0][2] as JSON string
                const dataStr = response[0]?.[2];
                if (dataStr) {
                    const data = JSON.parse(dataStr);
                    const conversations = data[0] || [];

                    conversations.forEach(conv => {
                        // Conv structure: [id, title, timestamp, ...]
                        const uuid = conv[0] || '';
                        const title = conv[1] || conv[2] || 'Gemini Chat';

                        if (uuid) {
                            threads.push({
                                uuid,
                                title: title.slice(0, 100),
                                platform: 'Gemini',
                                last_query_datetime: new Date().toISOString()
                            });
                        }
                    });

                    if (threads.length > 0) {
                        // Get next cursor for pagination
                        const nextCursor = data[1] || null;
                        return {
                            threads,
                            hasMore: !!nextCursor,
                            nextCursor,
                            page
                        };
                    }
                }
            }
        } catch (e) {
            console.warn('[GeminiAdapter] API failed, using DOM fallback:', e.message);
        }

        // DOM Fallback: Parse sidebar chat items
        try {
            const chatItems = document.querySelectorAll(
                'a[href*="/app/"], [class*="conversation"], div.conversation'
            );
            chatItems.forEach((item, i) => {
                if (i >= limit) return;
                const href = item.getAttribute('href') || '';
                const uuidMatch = href.match(/\/app\/([a-zA-Z0-9_-]+)/) ||
                    href.match(/\/gem\/([a-zA-Z0-9_-]+)/);
                if (uuidMatch) {
                    threads.push({
                        uuid: uuidMatch[1],
                        title: item.innerText?.trim()?.slice(0, 100) || 'Gemini Chat',
                        platform: 'Gemini',
                        last_query_datetime: new Date().toISOString()
                    });
                }
            });
        } catch (e) { }

        // Final fallback: current chat
        if (threads.length === 0) {
            const currentUuid = this.extractUuid(window.location.href);
            threads.push({
                uuid: currentUuid,
                title: document.title?.replace(' - Gemini', '').replace('Google Gemini', '').trim() || 'Gemini Chat',
                platform: 'Gemini',
                last_query_datetime: new Date().toISOString()
            });
        }

        return { threads, hasMore: false, page };
    },

    // ============================================
    // ENTERPRISE: Get thread detail via API
    // FIXED: Better response parsing with multiple strategies
    // ============================================
    getThreadDetail: async function (uuid) {
        console.log(`[GeminiAdapter] Fetching thread detail for: ${uuid}`);

        // Try API first: rpcid hNvQHb for message history
        // Try multiple RPC IDs as Google may update them
        const rpcIds = ['hNvQHb', 'WqGlee', 'Mklfhc']; // Common Gemini RPC IDs
        
        for (const rpcId of rpcIds) {
            try {
                console.log(`[Gemini] Trying RPC ID: ${rpcId}`);
                // Payload variations
                const payloads = [
                    [uuid, 50, null, 1, [0], [4], null, 1],  // Standard format
                    [uuid, 100],                              // Simple format
                    [uuid]                                     // Minimal format
                ];

                for (const payload of payloads) {
                    try {
                        const response = await GeminiAdapter._batchExecute(rpcId, payload);

                        if (!response || !response[0]) continue;

                        // Try multiple parsing strategies
                        let data = null;
                        const dataStr = response[0]?.[2];
                        
                        if (dataStr) {
                            try {
                                data = JSON.parse(dataStr);
                            } catch {
                                console.warn('[Gemini] Could not parse response data string');
                                continue;
                            }
                        }

                        if (!data) continue;

                        const entries = [];
                        
                        // Strategy 1: Array of turns
                        const turns = data[0] || data[1] || data;
                        if (Array.isArray(turns) && turns.length > 0) {
                            let currentQuery = '';

                            turns.forEach((turn, idx) => {
                                // Multiple content extraction methods
                                let content = turn[1]?.[0] || turn[2]?.[0] || turn[0] || '';
                                const role = turn[3] || turn[2] || idx % 2;

                                // Clean content if it's an object
                                if (typeof content !== 'string') {
                                    content = Array.isArray(content) ? content.join('\n') : JSON.stringify(content);
                                }

                                // Detect role
                                const isUser = role === 0 || role === 'user' || role === 'USER' ||
                                              (idx % 2 === 0 && turn.length < 5);

                                if (isUser && content.trim()) {
                                    currentQuery = content.trim();
                                } else if (!isUser && currentQuery && content.trim()) {
                                    entries.push({ query: currentQuery, answer: content.trim() });
                                    currentQuery = '';
                                }
                            });
                        }

                        if (entries.length > 0) {
                            console.log(`[Gemini] ✓ API success with ${rpcId}: ${entries.length} entries`);
                            const title = data[0]?.[0] || data.title ||
                                document.title?.replace(' - Gemini', '').trim() ||
                                entries[0]?.query?.substring(0, 100) ||
                                'Gemini Conversation';
                            return { uuid, title, platform: 'Gemini', entries };
                        }
                    } catch (e) {
                        console.warn(`[Gemini] Payload attempt failed:`, e.message);
                    }
                }
            } catch (e) {
                console.warn(`[Gemini] RPC ${rpcId} failed:`, e.message);
            }
        }

        // DOM Fallback
        console.warn('[Gemini] All API attempts failed, using DOM extraction');
        return GeminiAdapter.extractFromDOM(uuid);
    },

    // ============================================
    // DOM Fallback (multiple strategies)
    // FIXED: Updated selectors for latest Gemini UI
    // ============================================
    extractFromDOM: function (uuid) {
        console.log('[Gemini] Starting DOM extraction...');
        const messages = [];

        // Strategy 1: Modern Gemini UI - message containers with data attributes
        const messageContainers = document.querySelectorAll('[data-message-author-role], message-content, [class*="message"]');
        if (messageContainers.length > 0) {
            console.log(`[Gemini] Strategy 1: Found ${messageContainers.length} message containers`);
            
            let currentQuery = '';
            messageContainers.forEach(container => {
                const role = container.getAttribute('data-message-author-role') ||
                           (container.className.includes('user') ? 'user' : 'model');
                const text = container.innerText?.trim() || '';

                if (text.length > 5) {
                    if (role === 'user') {
                        currentQuery = text;
                    } else if (role === 'model' && currentQuery) {
                        messages.push({ query: currentQuery, answer: text });
                        currentQuery = '';
                    }
                }
            });
        }

        // Strategy 2: Query-response pairs
        if (messages.length === 0) {
            console.log('[Gemini] Strategy 2: Query-response pairs');
            
            const userQueries = document.querySelectorAll(
                '[data-query-text], [class*="user-query"], [class*="prompt-text"], ' +
                '.query-content, user-message'
            );
            const aiResponses = document.querySelectorAll(
                '[data-model-response], [class*="model-response"], model-response, ' +
                '.response-content, model-message'
            );

            const max = Math.max(userQueries.length, aiResponses.length);
            for (let i = 0; i < max; i++) {
                const query = userQueries[i]?.innerText?.trim() || '';
                const answer = aiResponses[i]?.innerText?.trim() || '';
                if (query || answer) {
                    messages.push({ query, answer });
                }
            }
        }

        // Strategy 3: Alternating blocks in main content
        if (messages.length === 0) {
            console.log('[Gemini] Strategy 3: Alternating blocks');
            
            const mainContent = document.querySelector('main, [role="main"], .conversation-container');
            if (mainContent) {
                const blocks = mainContent.querySelectorAll('div[class*="turn"], div[class*="message-turn"]');
                
                if (blocks.length > 0) {
                    let currentQuery = '';
                    blocks.forEach((block, i) => {
                        const text = block.innerText?.trim();
                        if (text && text.length > 10) {
                            if (i % 2 === 0) {
                                currentQuery = text;
                            } else {
                                messages.push({ query: currentQuery, answer: text });
                                currentQuery = '';
                            }
                        }
                    });
                }
            }
        }

        // Strategy 4: Generic text extraction
        if (messages.length === 0) {
            console.log('[Gemini] Strategy 4: Generic extraction');
            
            const allText = [];
            const textElements = document.querySelectorAll('p, div[class*="text"]');
            textElements.forEach(el => {
                const text = el.innerText?.trim();
                if (text && text.length > 30 && !allText.includes(text)) {
                    allText.push(text);
                }
            });
            
            for (let i = 0; i < allText.length - 1; i += 2) {
                messages.push({ query: allText[i], answer: allText[i + 1] });
            }
        }

        const filteredMessages = messages.filter(m => m.query?.trim() && m.answer?.trim());
        console.log(`[Gemini] ✓ DOM extraction complete: ${filteredMessages.length} message pairs`);
        
        const title = document.title?.replace(' - Gemini', '').replace('Google Gemini', '').trim() ||
                     filteredMessages[0]?.query?.substring(0, 100) ||
                     'Gemini Conversation';

        return { uuid, title, platform: 'Gemini', entries: filteredMessages };
    },

    getSpaces: async function () { return []; }
};

window.GeminiAdapter = GeminiAdapter;
