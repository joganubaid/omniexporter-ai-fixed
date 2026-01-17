// OmniExporter AI - DeepSeek Adapter (Enterprise Edition)
// Support for DeepSeek AI (chat.deepseek.com)
// Enterprise-level implementation matching Perplexity quality
// VERIFIED API: /api/v0/chat_session/fetch_page (discovered 2026-01-10)
// NOW USES: platformConfig for centralized configuration

const DeepSeekAdapter = {
    name: "DeepSeek",

    // ============================================
    // ENTERPRISE: Use platformConfig for endpoints
    // ============================================
    get config() {
        return typeof platformConfig !== 'undefined'
            ? platformConfig.getConfig('DeepSeek')
            : null;
    },

    get apiBase() {
        const config = this.config;
        return config ? config.baseUrl + '/api/v0' : 'https://chat.deepseek.com/api/v0';
    },

    // Cursor cache for pagination (enables Load All and offset-based fetching)
    _cursorCache: [],
    _allThreadsCache: [],
    _cacheTimestamp: 0,
    _cacheTTL: 60000, // 1 minute cache

    extractUuid: (url) => {
        // Try platformConfig patterns first
        if (typeof platformConfig !== 'undefined') {
            const uuid = platformConfig.extractUuid('DeepSeek', url);
            if (uuid) return uuid;
        }

        // Fallback patterns
        // Pattern 1: /a/chat/s/{uuid} or /chat/s/{uuid}
        const chatMatch = url.match(/chat\.deepseek\.com(?:\/a)?\/chat\/s?\/([a-zA-Z0-9-]+)/);
        if (chatMatch) return chatMatch[1];

        // Pattern 2: session parameter
        const sessionMatch = url.match(/[?&](?:s|session|chat_session_id)=([a-zA-Z0-9-]+)/);
        if (sessionMatch) return sessionMatch[1];

        // Pattern 3: UUID in URL
        const uuidMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (uuidMatch) return uuidMatch[1];

        return null;
    },

    // ============================================
    // ENTERPRISE: Get auth token from localStorage
    // DeepSeek stores token as JSON: {value: "...", ...}
    // FIXED: Added multiple token source attempts
    // ============================================
    _getAuthToken: () => {
        try {
            // Try multiple possible token storage keys
            const tokenKeys = [
                'userToken',
                'deepseek_token',
                'auth_token',
                'access_token',
                'ds_token'
            ];

            for (const key of tokenKeys) {
                try {
                    const tokenData = localStorage.getItem(key);
                    if (!tokenData) continue;

                    // Try parsing as JSON first
                    try {
                        const parsed = JSON.parse(tokenData);
                        const token = parsed.value || parsed.token || parsed.access_token;
                        if (token) {
                            console.log(`[DeepSeek] Found token in localStorage key: ${key}`);
                            return token;
                        }
                    } catch {
                        // Not JSON, might be plain string token
                        if (tokenData.length > 10) {
                            console.log(`[DeepSeek] Using plain token from key: ${key}`);
                            return tokenData;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }

            console.warn('[DeepSeek] No auth token found in localStorage');
            return null;
        } catch (e) {
            console.error('[DeepSeek] Error reading auth token:', e.message);
            return null;
        }
    },

    // ============================================
    // ENTERPRISE: Retry with exponential backoff + Auth
    // ============================================
    _fetchWithRetry: async (url, options = {}, maxRetries = 3) => {
        let lastError;

        // Get auth token
        const token = DeepSeekAdapter._getAuthToken();
        const headers = {
            'Accept': 'application/json',
            ...options.headers
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    headers,
                    ...options
                });
                if (response.ok) return response;
                if (response.status === 401 || response.status === 403) {
                    throw new Error('Authentication required - please login to DeepSeek');
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
    // ENTERPRISE: Fetch single page with cursor
    // ============================================
    _fetchPage: async (cursor = null, limit = 50) => {
        let url = `${DeepSeekAdapter.apiBase}/chat_session/fetch_page?lte_cursor.pinned=false`;
        if (cursor) {
            url += `&cursor=${encodeURIComponent(cursor)}`;
        }

        const response = await DeepSeekAdapter._fetchWithRetry(url);
        const data = await response.json();

        // Extract sessions from various response formats
        const bizData = data.data?.biz_data || data.biz_data || data.data || data;
        const sessions = bizData.chat_sessions || bizData.sessions || [];
        const nextCursor = bizData.next_cursor || bizData.cursor || null;
        const hasMore = sessions.length >= limit && nextCursor;

        const threads = sessions.map(chat => ({
            uuid: chat.id || chat.chat_session_id || chat.session_id,
            title: chat.title || chat.name || 'DeepSeek Chat',
            platform: 'DeepSeek',
            last_query_datetime: chat.updated_at || chat.create_time || new Date().toISOString()
        }));

        return { threads, nextCursor, hasMore };
    },

    // ============================================
    // ENTERPRISE: Fetch ALL threads (Load All)
    // ============================================
    getAllThreads: async (progressCallback = null) => {
        const allThreads = [];
        let cursor = null;
        let pageNum = 0;
        const seenIds = new Set();

        try {
            do {
                const { threads, nextCursor, hasMore } = await DeepSeekAdapter._fetchPage(cursor, 50);

                // Dedupe threads
                threads.forEach(t => {
                    if (!seenIds.has(t.uuid)) {
                        seenIds.add(t.uuid);
                        allThreads.push(t);
                    }
                });

                // Store cursor for later offset-based access
                if (cursor) {
                    DeepSeekAdapter._cursorCache.push({ cursor, index: allThreads.length - threads.length });
                }

                cursor = nextCursor;
                pageNum++;

                // Progress callback for UI
                if (progressCallback) {
                    progressCallback(allThreads.length, hasMore);
                }

                // Safety limit
                if (pageNum > 100 || allThreads.length > 5000) break;

                // Rate limiting
                if (hasMore) await new Promise(r => setTimeout(r, 300));

            } while (cursor);

            // Update cache
            DeepSeekAdapter._allThreadsCache = allThreads;
            DeepSeekAdapter._cacheTimestamp = Date.now();

            return allThreads;
        } catch (error) {
            console.error('[DeepSeekAdapter] getAllThreads failed:', error);
            throw error;
        }
    },

    // ============================================
    // ENTERPRISE: Offset-based fetching (for options.js)
    // ============================================
    getThreadsWithOffset: async (offset = 0, limit = 50) => {
        // Check cache validity
        const cacheValid = DeepSeekAdapter._cacheTimestamp > Date.now() - DeepSeekAdapter._cacheTTL;

        if (cacheValid && DeepSeekAdapter._allThreadsCache.length > 0) {
            // Return from cache
            const threads = DeepSeekAdapter._allThreadsCache.slice(offset, offset + limit);
            return {
                threads,
                offset,
                hasMore: offset + limit < DeepSeekAdapter._allThreadsCache.length,
                total: DeepSeekAdapter._allThreadsCache.length
            };
        }

        // First call - fetch first page and cache
        if (offset === 0) {
            const { threads, nextCursor, hasMore } = await DeepSeekAdapter._fetchPage(null, limit);
            DeepSeekAdapter._cursorCache = [{ cursor: null, index: 0 }];
            if (nextCursor) {
                DeepSeekAdapter._cursorCache.push({ cursor: nextCursor, index: limit });
            }
            return { threads, offset: 0, hasMore, total: hasMore ? -1 : threads.length };
        }

        // Find closest cursor for this offset
        let closestCursor = null;
        let closestIndex = 0;
        for (const cached of DeepSeekAdapter._cursorCache) {
            if (cached.index <= offset && cached.index > closestIndex) {
                closestIndex = cached.index;
                closestCursor = cached.cursor;
            }
        }

        // Fetch pages until we reach the offset
        let currentIndex = closestIndex;
        let cursor = closestCursor;
        let resultThreads = [];

        while (currentIndex < offset + limit) {
            const { threads, nextCursor, hasMore } = await DeepSeekAdapter._fetchPage(cursor, 50);

            // Add to cursor cache
            if (nextCursor && !DeepSeekAdapter._cursorCache.find(c => c.cursor === nextCursor)) {
                DeepSeekAdapter._cursorCache.push({ cursor: nextCursor, index: currentIndex + threads.length });
            }

            // Collect threads in range
            threads.forEach((t, i) => {
                const globalIndex = currentIndex + i;
                if (globalIndex >= offset && globalIndex < offset + limit) {
                    resultThreads.push(t);
                }
            });

            currentIndex += threads.length;
            cursor = nextCursor;

            if (!hasMore || !cursor) break;
            await new Promise(r => setTimeout(r, 200));
        }

        return {
            threads: resultThreads,
            offset,
            hasMore: cursor !== null,
            total: -1
        };
    },

    // ============================================
    // Standard getThreads (page-based, backwards compatible)
    // ============================================
    getThreads: async (page = 1, limit = 50, spaceId = null) => {
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

        // Use offset-based internally
        const offset = (page - 1) * limit;
        const result = await DeepSeekAdapter.getThreadsWithOffset(offset, limit);

        return {
            threads: result.threads,
            hasMore: result.hasMore,
            page
        };
    },

    // ============================================
    // Thread Detail - FIXED: Multiple endpoint attempts and better parsing
    // Messages are in data.biz_data.chat_messages
    // Role is 'USER' or 'ASSISTANT' (uppercase)
    // ============================================
    getThreadDetail: async (uuid) => {
        console.log(`[DeepSeek] Fetching thread detail for UUID: ${uuid}`);

        // Try multiple API endpoint variations
        const endpoints = [
            `/chat/history_messages?chat_session_id=${uuid}`,
            `/chat/${uuid}/history_message?lte_cursor.id=`,
            `/chat_session/${uuid}`,
            `/chat/${uuid}`
        ];

        for (const endpoint of endpoints) {
            try {
                console.log(`[DeepSeek] Trying endpoint: ${endpoint}`);
                const response = await DeepSeekAdapter._fetchWithRetry(
                    `${DeepSeekAdapter.apiBase}${endpoint}`,
                    {},
                    2  // Max 2 retries per endpoint
                );

                const data = await response.json();
                console.log(`[DeepSeek] Response received for ${endpoint}`);

                // Try multiple response structure variations
                let messages = null;
                let title = 'DeepSeek Conversation';

                // Path variations for messages
                const messagePaths = [
                    data?.data?.biz_data?.chat_messages,
                    data?.biz_data?.chat_messages,
                    data?.data?.messages,
                    data?.messages,
                    data?.data?.chat_messages,
                    data?.chat_messages
                ];

                for (const path of messagePaths) {
                    if (Array.isArray(path) && path.length > 0) {
                        messages = path;
                        break;
                    }
                }

                if (!messages || messages.length === 0) {
                    console.warn(`[DeepSeek] No messages found in endpoint: ${endpoint}`);
                    continue;
                }

                console.log(`[DeepSeek] Found ${messages.length} messages`);

                const entries = [];
                let currentQuery = '';

                messages.forEach((msg, idx) => {
                    // Multiple role detection strategies
                    const role = (msg.role || msg.author || msg.sender || msg.type || '').toUpperCase();
                    const content = msg.content || msg.text || msg.message || '';

                    if (!content.trim()) return;

                    const isUser = role === 'USER' || role === 'HUMAN' || 
                                 (role === '' && idx % 2 === 0);
                    const isAssistant = role === 'ASSISTANT' || role === 'BOT' || 
                                       role === 'DEEPSEEK' || role === 'AI' ||
                                       (role === '' && idx % 2 === 1);

                    if (isUser) {
                        currentQuery = content.trim();
                    } else if (isAssistant && currentQuery) {
                        entries.push({ query: currentQuery, answer: content.trim() });
                        currentQuery = '';
                    }
                });

                if (entries.length > 0) {
                    // Get title from multiple possible locations
                    title = data?.data?.biz_data?.chat_session?.title ||
                           data?.biz_data?.chat_session?.title ||
                           data?.data?.title ||
                           data?.title ||
                           data?.chat_session?.title ||
                           entries[0]?.query?.substring(0, 100) ||
                           `DeepSeek Thread ${uuid.slice(0, 8)}`;

                    console.log(`[DeepSeek] ✓ API success: ${entries.length} Q&A pairs for: ${title}`);
                    return { uuid, title, platform: 'DeepSeek', entries };
                }
            } catch (e) {
                console.warn(`[DeepSeek] Endpoint ${endpoint} failed:`, e.message);
                continue;
            }
        }

        // DOM fallback
        console.warn(`[DeepSeek] All API endpoints failed, using DOM extraction`);
        return DeepSeekAdapter.extractFromDOM(uuid);
    },

    // ============================================
    // DOM Fallback - FIXED: Updated selectors for latest DeepSeek UI
    // ============================================
    extractFromDOM: (uuid) => {
        console.log('[DeepSeek] Starting DOM extraction...');
        const messages = [];

        // Strategy 1: Modern DeepSeek UI - data-message-role or data-role attributes
        const roleElements = document.querySelectorAll('[data-message-role], [data-role]');
        if (roleElements.length > 0) {
            console.log(`[DeepSeek] Strategy 1: Found ${roleElements.length} role-based elements`);
            
            let currentQuery = '';
            roleElements.forEach(el => {
                const role = (el.getAttribute('data-message-role') || el.getAttribute('data-role') || '').toUpperCase();
                const text = el.textContent?.trim() || '';

                if (text.length > 5) {
                    if (role === 'USER' || role === 'HUMAN') {
                        currentQuery = text;
                    } else if ((role === 'ASSISTANT' || role === 'BOT' || role === 'AI') && currentQuery) {
                        messages.push({ query: currentQuery, answer: text });
                        currentQuery = '';
                    }
                }
            });
        }

        // Strategy 2: Class-based message detection
        if (messages.length === 0) {
            console.log('[DeepSeek] Strategy 2: Class-based detection');
            
            const userSelectors = [
                '[class*="user-message"]',
                '[class*="human-message"]',
                '[class*="UserMessage"]',
                '.message-user',
                '.chat-message-user'
            ];
            const assistantSelectors = [
                '[class*="assistant-message"]',
                '[class*="ai-message"]',
                '[class*="AssistantMessage"]',
                '.message-assistant',
                '.chat-message-assistant',
                '[class*="deepseek-message"]'
            ];

            let userEls = [], assistantEls = [];
            
            for (const sel of userSelectors) {
                const found = document.querySelectorAll(sel);
                if (found.length > 0) {
                    userEls = Array.from(found);
                    console.log(`[DeepSeek] Found ${userEls.length} user messages with selector: ${sel}`);
                    break;
                }
            }
            
            for (const sel of assistantSelectors) {
                const found = document.querySelectorAll(sel);
                if (found.length > 0) {
                    assistantEls = Array.from(found);
                    console.log(`[DeepSeek] Found ${assistantEls.length} assistant messages with selector: ${sel}`);
                    break;
                }
            }

            const maxLen = Math.max(userEls.length, assistantEls.length);
            for (let i = 0; i < maxLen; i++) {
                const query = userEls[i]?.textContent?.trim() || '';
                const answer = assistantEls[i]?.textContent?.trim() || '';
                if (query || answer) {
                    messages.push({ query, answer });
                }
            }
        }

        // Strategy 3: Markdown/prose containers (alternating pattern)
        if (messages.length === 0) {
            console.log('[DeepSeek] Strategy 3: Markdown containers');
            
            const markdownBlocks = document.querySelectorAll(
                '[class*="markdown"], [class*="prose"], [class*="message-content"], .chat-content'
            );
            
            if (markdownBlocks.length > 0) {
                let currentQuery = '';
                markdownBlocks.forEach((block, i) => {
                    const text = block.textContent?.trim() || '';
                    if (text.length > 10) {
                        if (i % 2 === 0) {
                            currentQuery = text;
                        } else if (currentQuery) {
                            messages.push({ query: currentQuery, answer: text });
                            currentQuery = '';
                        }
                    }
                });
            }
        }

        // Strategy 4: Generic text blocks in main container
        if (messages.length === 0) {
            console.log('[DeepSeek] Strategy 4: Generic text extraction');
            
            const container = document.querySelector('.chat-container, .conversation-container, main');
            if (container) {
                const textBlocks = [];
                const elements = container.querySelectorAll('p, div[class*="text"]');
                
                elements.forEach(el => {
                    const text = el.textContent?.trim();
                    if (text && text.length > 20 && !textBlocks.includes(text)) {
                        textBlocks.push(text);
                    }
                });

                for (let i = 0; i < textBlocks.length - 1; i += 2) {
                    messages.push({ query: textBlocks[i], answer: textBlocks[i + 1] });
                }
            }
        }

        const filteredMessages = messages.filter(m => m.query?.trim() && m.answer?.trim());
        console.log(`[DeepSeek] ✓ DOM extraction complete: ${filteredMessages.length} message pairs`);

        const title = document.title?.replace(' - DeepSeek', '').replace('DeepSeek Chat', '').trim() ||
                     filteredMessages[0]?.query?.substring(0, 100) ||
                     'DeepSeek Conversation';

        return { uuid, title, platform: 'DeepSeek', entries: filteredMessages };
    },

    getSpaces: async () => []
};

window.DeepSeekAdapter = DeepSeekAdapter;
