/**
 * OmniExporter AI - Comprehensive Test Suite
 * Run these tests in the browser console on Options page
 * 
 * Usage: Copy this file content into console and run testAll()
 */

const TestSuite = {
    results: [],

    // Test utilities
    async test(name, fn) {
        try {
            await fn();
            this.results.push({ name, passed: true });
            console.log(`✅ ${name}`);
            return true;
        } catch (e) {
            this.results.push({ name, passed: false, error: e.message });
            console.error(`❌ ${name}:`, e.message);
            return false;
        }
    },

    assert(condition, message) {
        if (!condition) throw new Error(message || 'Assertion failed');
    },

    assertEqual(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(message || `Expected ${expected}, got ${actual}`);
        }
    },

    // ============================================
    // LOGGER TESTS
    // ============================================
    async testLoggerModule() {
        await this.test('Logger exists', () => {
            this.assert(typeof Logger !== 'undefined', 'Logger not defined');
        });

        await this.test('Logger has required methods', () => {
            this.assert(typeof Logger.info === 'function', 'Logger.info missing');
            this.assert(typeof Logger.error === 'function', 'Logger.error missing');
            this.assert(typeof Logger.warn === 'function', 'Logger.warn missing');
            this.assert(typeof Logger.debug === 'function', 'Logger.debug missing');
        });

        await this.test('Logger.init works', async () => {
            await Logger.init();
            this.assert(Logger._initialized === true, 'Logger not initialized');
        });

        await this.test('Logger stores entries when enabled', async () => {
            await chrome.storage.local.set({ debugMode: true });
            Logger.config.enabled = true;
            Logger.info('Test', 'Test message', { test: true });

            // Wait for flush
            await new Promise(r => setTimeout(r, 1500));

            const { omniExporterLogs } = await chrome.storage.local.get('omniExporterLogs');
            this.assert(omniExporterLogs && omniExporterLogs.length > 0, 'Logs not stored');
        });

        await this.test('Logger sanitizes sensitive data', () => {
            const result = Logger._sanitizeData({ password: 'secret123', normal: 'value' });
            this.assertEqual(result.password, '[REDACTED]', 'Password not redacted');
            this.assertEqual(result.normal, 'value', 'Normal value changed');
        });

        await this.test('Logger.getLogs returns array', async () => {
            const logs = await Logger.getLogs();
            this.assert(Array.isArray(logs), 'getLogs did not return array');
        });

        await this.test('Logger.getStats returns stats object', async () => {
            const stats = await Logger.getStats();
            this.assert(typeof stats.total === 'number', 'Stats.total not a number');
            this.assert(typeof stats.byLevel === 'object', 'Stats.byLevel not an object');
        });
    },

    // ============================================
    // STORAGE TESTS
    // ============================================
    async testStorage() {
        await this.test('Chrome storage accessible', async () => {
            await chrome.storage.local.set({ testKey: 'testValue' });
            const result = await chrome.storage.local.get('testKey');
            this.assertEqual(result.testKey, 'testValue', 'Storage read/write failed');
            await chrome.storage.local.remove('testKey');
        });

        await this.test('Settings persist', async () => {
            const original = await chrome.storage.local.get('debugMode');
            await chrome.storage.local.set({ debugMode: true });
            const after = await chrome.storage.local.get('debugMode');
            this.assertEqual(after.debugMode, true, 'Setting not saved');
            // Restore
            await chrome.storage.local.set({ debugMode: original.debugMode || false });
        });
    },

    // ============================================
    // NOTION OAUTH TESTS
    // ============================================
    async testNotionOAuth() {
        await this.test('NotionOAuth module exists', () => {
            this.assert(typeof NotionOAuth !== 'undefined', 'NotionOAuth not defined');
        });

        await this.test('NotionOAuth has required methods', () => {
            this.assert(typeof NotionOAuth.init === 'function', 'init missing');
            this.assert(typeof NotionOAuth.isConfigured === 'function', 'isConfigured missing');
            this.assert(typeof NotionOAuth.getActiveToken === 'function', 'getActiveToken missing');
        });

        await this.test('NotionOAuth.init works', async () => {
            const result = await NotionOAuth.init();
            this.assertEqual(result, true, 'Init did not return true');
        });
    },

    // ============================================
    // EXPORT MANAGER TESTS
    // ============================================
    async testExportManager() {
        await this.test('ExportManager exists', () => {
            this.assert(typeof ExportManager !== 'undefined', 'ExportManager not defined');
        });

        await this.test('ExportManager has formats', () => {
            this.assert(ExportManager.formats.markdown, 'Markdown format missing');
            this.assert(ExportManager.formats.json, 'JSON format missing');
            this.assert(ExportManager.formats.html, 'HTML format missing');
        });

        await this.test('ExportManager.toMarkdown works', () => {
            const testData = {
                title: 'Test Chat',
                uuid: 'test-123',
                detail: {
                    entries: [{
                        query: 'What is AI?',
                        blocks: [{
                            intended_usage: 'ask_text',
                            markdown_block: { answer: 'AI is...' }
                        }]
                    }]
                }
            };
            const md = ExportManager.toMarkdown(testData, 'Perplexity');
            this.assert(md.includes('Test Chat'), 'Title not in markdown');
            this.assert(md.includes('What is AI?'), 'Query not in markdown');
        });

        await this.test('ExportManager.toJSON works', () => {
            const testData = { title: 'Test', detail: { entries: [] } };
            const json = ExportManager.toJSON(testData, 'ChatGPT');
            const parsed = JSON.parse(json);
            this.assert(parsed.meta.tool === 'OmniExporter AI', 'Meta tool incorrect');
        });

        await this.test('ExportManager.escapeHtml works', () => {
            const result = ExportManager.escapeHtml('<script>alert("xss")</script>');
            this.assert(!result.includes('<script>'), 'HTML not escaped');
        });
    },

    // ============================================
    // UI TESTS
    // ============================================
    async testUI() {
        await this.test('Dev Tools tab exists', () => {
            const tab = document.querySelector('[data-tab="devtools"]');
            this.assert(tab !== null, 'Dev Tools tab not found');
        });

        await this.test('Debug toggle exists', () => {
            const toggle = document.getElementById('debugModeToggle');
            this.assert(toggle !== null, 'Debug toggle not found');
        });

        await this.test('Log viewer container exists', () => {
            const container = document.getElementById('logEntries');
            this.assert(container !== null, 'Log entries container not found');
        });

        await this.test('Filter controls exist', () => {
            const levelFilter = document.getElementById('logLevelFilter');
            const moduleFilter = document.getElementById('logModuleFilter');
            this.assert(levelFilter !== null, 'Level filter not found');
            this.assert(moduleFilter !== null, 'Module filter not found');
        });
    },

    // ============================================
    // RUN ALL TESTS
    // ============================================
    async runAll() {
        console.log('🧪 Starting OmniExporter Test Suite...\n');
        this.results = [];

        console.log('\n📝 LOGGER TESTS');
        await this.testLoggerModule();

        console.log('\n💾 STORAGE TESTS');
        await this.testStorage();

        console.log('\n🔐 NOTION OAUTH TESTS');
        await this.testNotionOAuth();

        console.log('\n📤 EXPORT MANAGER TESTS');
        await this.testExportManager();

        console.log('\n🖥️ UI TESTS');
        await this.testUI();

        // Summary
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.filter(r => !r.passed).length;

        console.log('\n' + '='.repeat(50));
        console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
        console.log('='.repeat(50));

        if (failed > 0) {
            console.log('\n❌ FAILED TESTS:');
            this.results.filter(r => !r.passed).forEach(r => {
                console.log(`  - ${r.name}: ${r.error}`);
            });
        }

        return { passed, failed, results: this.results };
    }
};

// Quick access
const testAll = () => TestSuite.runAll();
console.log('✨ Test suite loaded. Run testAll() to execute all tests.');
