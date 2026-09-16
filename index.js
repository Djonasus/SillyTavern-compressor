import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

/** Settings key in extension_settings (stable across folder renames) */
const EXTENSION_NAME = 'compressor';
const PROMPT_KEY = 'compressor_facts';
const METADATA_KEY = 'compressor';

/**
 * Resolve where this extension is actually served from
 * (e.g. third-party/compressor or third-party/SillyTavern-compressor).
 */
function getExtensionMountPath() {
    try {
        const pathName = new URL('.', import.meta.url).pathname.replace(/\/+$/, '');
        const marker = '/scripts/extensions/';
        const idx = pathName.indexOf(marker);
        if (idx !== -1) {
            return pathName.slice(idx + marker.length);
        }
    } catch (error) {
        console.warn('[compressor] Failed to resolve mount path:', error);
    }
    return `third-party/${EXTENSION_NAME}`;
}

function getSettingsHtmlUrl() {
    return new URL('settings.html', import.meta.url).href;
}

const EXTENSION_MOUNT = getExtensionMountPath();
const EXTENSION_FOLDER = `scripts/extensions/${EXTENSION_MOUNT}`;

const EXTENSION_PROMPT_TYPES = {
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

const DEFAULT_CHRONO_PROMPT = [
    'OOC / System task only. Do NOT write in character. Do NOT continue the roleplay.',
    'Create a concise chronological timeline of what happened in the chat transcript.',
    'List events in order. Keep character names, important decisions, locations, and unresolved threads.',
    'Do not invent facts. Do not write dialogue or narration. Output ONLY the chronology.',
    '',
    'Chat transcript:',
    '{{transcript}}',
].join('\n');

const DEFAULT_FACTS_PROMPT = [
    'OOC / System task only. Do NOT write in character. Do NOT continue the roleplay.',
    'From the chat transcript and the existing user facts, produce an updated list of lasting facts ABOUT THE USER (preferences, identity, relationships, ongoing plans).',
    'Merge: keep still-true facts, update changed ones, add new ones, drop obsolete ones.',
    'Output ONLY a JSON array of strings, e.g. ["Fact one","Fact two"]. No markdown fences. No dialogue.',
].join(' ');

const DEFAULT_FACTS_TEMPLATE = '[User facts]\n{{facts}}';
const DEFAULT_CHRONOLOGY_TEMPLATE = '[Chronology]\n{{summary}}';

const GENERATION_MODES = {
    CLASSIC: 'classic',
    RAW: 'raw',
};

const defaultSettings = {
    factsEnabled: false,
    skipSystemMessages: true,
    generationMode: GENERATION_MODES.RAW,
    responseLength: 0,
    factsDepth: 0,
    factsPosition: EXTENSION_PROMPT_TYPES.BEFORE_PROMPT,
    chronologyTemplate: DEFAULT_CHRONOLOGY_TEMPLATE,
    chronoPrompt: DEFAULT_CHRONO_PROMPT,
    factsPrompt: DEFAULT_FACTS_PROMPT,
    factsTemplate: DEFAULT_FACTS_TEMPLATE,
};

let busy = false;

function ctx() {
    return getContext();
}

function settings() {
    return extension_settings[EXTENSION_NAME];
}

function loadSettings() {
    if (!extension_settings[EXTENSION_NAME] || typeof extension_settings[EXTENSION_NAME] !== 'object') {
        extension_settings[EXTENSION_NAME] = {};
    }
    const s = extension_settings[EXTENSION_NAME];

    // Migrate old prefix field → template
    if (s.chronologyTemplate === undefined && s.chronologyPrefix !== undefined) {
        const prefix = String(s.chronologyPrefix || '').trim();
        s.chronologyTemplate = prefix
            ? `${prefix}\n{{summary}}`
            : DEFAULT_CHRONOLOGY_TEMPLATE;
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = value;
        }
    }
}

/**
 * Replace {{key}} / {key} and run ST macros when available.
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function applyTemplate(template, vars = {}) {
    let out = String(template ?? '');
    for (const [key, value] of Object.entries(vars)) {
        const text = String(value ?? '');
        out = out.replaceAll(`{{${key}}}`, text).replaceAll(`{${key}}`, text);
    }

    const context = ctx();
    try {
        if (typeof context.substituteParamsExtended === 'function') {
            out = context.substituteParamsExtended(out, vars);
        } else if (typeof context.substituteParams === 'function') {
            out = context.substituteParams(out);
        }
    } catch (error) {
        console.warn('[compressor] Macro substitution failed:', error);
    }

    return out;
}

function updateFactsUiVisibility() {
    const root = $('#compressor_settings');
    if (!root.length) {
        return;
    }
    root.toggleClass('compressor_facts_off', !settings().factsEnabled);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 15000, intervalMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) {
            return true;
        }
        await delay(intervalMs);
    }
    throw new Error('Timed out waiting for condition');
}

function stringToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach(b => {
        binary += String.fromCharCode(b);
    });
    return btoa(binary);
}

function sanitizeFileKey(raw) {
    return String(raw || 'unknown')
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9_\-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 80) || 'unknown';
}

function getCharacterKey(context = ctx()) {
    const id = context.characterId;
    if (id === undefined || id === null || !context.characters?.[id]) {
        return null;
    }
    const character = context.characters[id];
    return sanitizeFileKey(character.avatar || character.name || `char_${id}`);
}

function getFactsFileName(characterKey) {
    return `compressor-facts-${characterKey}.json`;
}

function getFactsFileUrl(characterKey) {
    return `/user/files/${getFactsFileName(characterKey)}`;
}

/**
 * @returns {Promise<{ characterKey: string, updatedAt: string, facts: { id: string, text: string, sourceChat?: string }[] }>}
 */
async function loadFacts(characterKey) {
    const empty = {
        characterKey,
        updatedAt: '',
        facts: [],
    };
    if (!characterKey) {
        return empty;
    }

    try {
        const response = await fetch(getFactsFileUrl(characterKey), {
            method: 'GET',
            cache: 'no-store',
            headers: ctx().getRequestHeaders(),
            credentials: 'include',
        });
        if (response.status === 404) {
            return empty;
        }
        if (!response.ok) {
            console.warn('[compressor] Failed to load facts:', response.status);
            return empty;
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.facts)) {
            return empty;
        }
        return {
            characterKey,
            updatedAt: data.updatedAt || '',
            facts: data.facts
                .filter(f => f && typeof f.text === 'string' && f.text.trim())
                .map(f => ({
                    id: f.id || ctx().uuidv4(),
                    text: String(f.text).trim(),
                    sourceChat: f.sourceChat || '',
                })),
        };
    } catch (error) {
        console.warn('[compressor] Facts load error:', error);
        return empty;
    }
}

/**
 * @param {string} characterKey
 * @param {{ id?: string, text: string, sourceChat?: string }[]|string[]} facts
 * @param {string} [sourceChat]
 */
async function saveFacts(characterKey, facts, sourceChat = '') {
    const context = ctx();
    const normalized = facts
        .map(item => {
            if (typeof item === 'string') {
                return {
                    id: context.uuidv4(),
                    text: item.trim(),
                    sourceChat,
                };
            }
            return {
                id: item.id || context.uuidv4(),
                text: String(item.text || '').trim(),
                sourceChat: item.sourceChat || sourceChat,
            };
        })
        .filter(f => f.text);

    const payload = {
        characterKey,
        updatedAt: new Date().toISOString(),
        facts: normalized,
    };

    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            name: getFactsFileName(characterKey),
            data: stringToBase64(JSON.stringify(payload, null, 2)),
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to upload facts file');
    }

    return payload;
}

function formatFactsForPrompt(factsDocument) {
    const s = settings();
    const lines = (factsDocument?.facts || []).map(f => `- ${f.text}`);
    if (!lines.length) {
        return '';
    }
    const body = lines.join('\n');
    const template = s.factsTemplate || DEFAULT_FACTS_TEMPLATE;
    if (template.includes('{{facts}}') || template.includes('{facts}')) {
        return applyTemplate(template, { facts: body });
    }
    return applyTemplate(`${template}\n{{facts}}`, { facts: body });
}

function clearFactsPrompt() {
    ctx().setExtensionPrompt(PROMPT_KEY, '', EXTENSION_PROMPT_TYPES.IN_PROMPT, 0);
}

function applyFactsPrompt(factsDocument) {
    const s = settings();
    if (!s.factsEnabled) {
        clearFactsPrompt();
        return;
    }
    const value = formatFactsForPrompt(factsDocument);
    if (!value) {
        clearFactsPrompt();
        return;
    }
    const position = Number(s.factsPosition);
    const depth = Number(s.factsDepth) || 0;
    ctx().setExtensionPrompt(PROMPT_KEY, value, position, depth, false, 0);
}

async function refreshFactsInjection() {
    const characterKey = getCharacterKey();
    if (!characterKey || !settings().factsEnabled) {
        clearFactsPrompt();
        return null;
    }
    const doc = await loadFacts(characterKey);
    applyFactsPrompt(doc);
    return doc;
}

function buildTranscript(chat, skipSystem) {
    const lines = [];
    for (const message of chat) {
        if (!message?.mes || !String(message.mes).trim()) {
            continue;
        }
        if (skipSystem && message.is_system) {
            continue;
        }
        const name = message.name || (message.is_user ? 'User' : 'Character');
        const role = message.is_user ? 'User' : (message.is_system ? 'System' : 'Character');
        lines.push(`${name} (${role}): ${String(message.mes).trim()}`);
    }
    return lines.join('\n\n');
}

function parseFactsFromModel(raw) {
    if (!raw) {
        return [];
    }
    let text = String(raw).trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        text = fence[1].trim();
    }

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed.map(x => String(x).trim()).filter(Boolean);
        }
        if (parsed && Array.isArray(parsed.facts)) {
            return parsed.facts.map(x => (typeof x === 'string' ? x : x.text)).map(x => String(x).trim()).filter(Boolean);
        }
    } catch {
        // fall through to line parsing
    }

    return text
        .split(/\r?\n/)
        .map(line => line.replace(/^[-*•\d.)\s]+/, '').trim())
        .filter(Boolean)
        .filter(line => line !== '[' && line !== ']');
}

/**
 * Split a templated prompt into system instruction + transcript body for Raw mode.
 * @param {string} promptTemplate
 * @param {string} transcript
 * @returns {{ systemPrompt: string, prompt: string, classicPrompt: string }}
 */
function buildGenerationPrompts(promptTemplate, transcript) {
    const template = promptTemplate || '';
    const classicPrompt = (() => {
        let prompt = applyTemplate(template, { transcript });
        if (!template.includes('{{transcript}}') && !template.includes('{transcript}')) {
            prompt = `${prompt}\n\nChat transcript:\n${transcript}`;
        }
        return prompt;
    })();

    let systemPrompt = template
        .replaceAll('{{transcript}}', '')
        .replaceAll('{transcript}', '')
        .replace(/\n*Chat transcript:\s*$/i, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    systemPrompt = applyTemplate(systemPrompt || template, {});
    if (!systemPrompt.trim()) {
        systemPrompt = 'Summarize the chat transcript. Output only the summary.';
    }

    return {
        systemPrompt,
        prompt: transcript,
        classicPrompt,
    };
}

/**
 * @param {string} promptTemplate Templated instruction (may include {{transcript}})
 * @param {string} transcript Chat transcript
 * @param {number} [responseLength]
 * @returns {Promise<string>}
 */
async function generateText(promptTemplate, transcript, responseLength = 0) {
    const context = ctx();
    const mode = settings().generationMode === GENERATION_MODES.CLASSIC
        ? GENERATION_MODES.CLASSIC
        : GENERATION_MODES.RAW;
    const { systemPrompt, prompt, classicPrompt } = buildGenerationPrompts(promptTemplate, transcript);

    if (mode === GENERATION_MODES.RAW) {
        if (typeof context.generateRaw !== 'function') {
            toastr.warning('generateRaw unavailable; falling back to Classic');
        } else {
            const params = {
                prompt,
                systemPrompt,
                quietToLoud: false,
            };
            if (responseLength > 0) {
                params.responseLength = responseLength;
            }
            const result = await context.generateRaw(params);
            return String(result || '').trim();
        }
    }

    const params = {
        quietPrompt: classicPrompt,
        skipWIAN: true,
        removeReasoning: true,
    };
    if (responseLength > 0) {
        params.responseLength = responseLength;
    }
    const result = await context.generateQuietPrompt(params);
    return String(result || '').trim();
}

async function generateChronology(transcript) {
    const s = settings();
    return generateText(s.chronoPrompt || DEFAULT_CHRONO_PROMPT, transcript, Number(s.responseLength) || 0);
}

async function generateUpdatedFacts(transcript, existingFacts) {
    const s = settings();
    const existing = existingFacts.length
        ? existingFacts.map(f => `- ${f.text}`).join('\n')
        : '(none)';
    const promptTemplate = [
        s.factsPrompt || DEFAULT_FACTS_PROMPT,
        '',
        'Existing user facts:',
        existing,
        '',
        'Chat transcript:',
        '{{transcript}}',
    ].join('\n');
    const raw = await generateText(promptTemplate, transcript, Number(s.responseLength) || 0);
    return parseFactsFromModel(raw);
}

/**
 * Show generated chronology in an editable popup.
 * @param {string} chronology
 * @returns {Promise<string|null>} Edited text, or null if cancelled
 */
async function reviewChronologyPopup(chronology) {
    const context = ctx();
    const edited = await context.Popup.show.input(
        'Review chronology',
        'Edit the summary if needed, then continue. Cancel aborts compression.',
        chronology,
        {
            rows: 16,
            wide: true,
            large: true,
            okButton: 'Continue',
            cancelButton: 'Cancel',
            allowVerticalScrolling: true,
        },
    );

    if (edited === null) {
        return null;
    }

    const trimmed = String(edited).trim();
    if (!trimmed) {
        toastr.error('Chronology cannot be empty');
        return null;
    }

    return trimmed;
}

async function askDeleteOldChat() {
    const context = ctx();
    const result = await context.Popup.show.confirm(
        'Delete the current chat after compressing?',
        'Yes deletes the old chat file. No keeps it as an archive and still opens a new chat.',
        {
            okButton: 'Delete old chat',
            cancelButton: 'Keep old chat',
        },
    );

    if (result === context.POPUP_RESULT.CANCELLED || result === null) {
        return null;
    }
    return result === context.POPUP_RESULT.AFFIRMATIVE;
}

async function startNewChat(deleteOld) {
    const context = ctx();
    const command = deleteOld ? '/newchat delete=true' : '/newchat';

    const created = new Promise(resolve => {
        context.eventSource.once(context.eventTypes.CHAT_CREATED, () => resolve());
    });

    await context.executeSlashCommandsWithOptions(command);
    try {
        await Promise.race([created, delay(8000)]);
    } catch {
        // ignore
    }

    await waitUntil(() => Array.isArray(context.chat) && context.chat.length >= 1, 15000, 50);
}

function buildChronologyMessage(chronologyText) {
    const s = settings();
    const template = s.chronologyTemplate || DEFAULT_CHRONOLOGY_TEMPLATE;
    const summary = chronologyText.trim();
    let mes = applyTemplate(template, { summary });

    // If template forgot the placeholder, append the summary
    if (!template.includes('{{summary}}') && !template.includes('{summary}')) {
        mes = `${mes}\n${summary}`.trim();
    }

    return {
        name: 'Chronology',
        is_user: false,
        is_system: true,
        send_date: new Date().toLocaleString(),
        mes: mes.trim(),
        extra: {
            type: 'generic',
            compressor: true,
            swipeable: false,
        },
    };
}

async function injectChronologyAfterGreeting(chronologyText, sourceChat) {
    const context = ctx();
    await waitUntil(() => context.chat.length >= 1, 10000, 50);

    // Avoid duplicating if compress somehow ran twice
    const already = context.chat.some(m => m?.extra?.compressor);
    if (already) {
        return;
    }

    const message = buildChronologyMessage(chronologyText);
    context.chat.push(message);
    context.addOneMessage(message);

    context.chatMetadata[METADATA_KEY] = {
        sourceChat: sourceChat || '',
        compressedAt: new Date().toISOString(),
        version: 1,
    };
    await context.saveMetadata();
    await context.saveChat();
}

/**
 * Main compress pipeline.
 * @returns {Promise<string>} Chronology text
 */
async function compressChat() {
    if (busy) {
        toastr.warning('Compression already in progress');
        return '';
    }

    const context = ctx();

    if (context.groupId) {
        toastr.error('Chat Compressor does not support group chats yet');
        return '';
    }

    if (context.characterId === undefined || context.characterId === null) {
        toastr.error('Select a character first');
        return '';
    }

    if (!context.chat?.length) {
        toastr.error('Chat is empty');
        return '';
    }

    if (context.onlineStatus === 'no_connection') {
        toastr.error('API is not connected');
        return '';
    }

    busy = true;
    $('#compressor_settings').addClass('compressor_busy');

    try {
        const characterKey = getCharacterKey(context);
        const sourceChat = context.getCurrentChatId?.() || context.chatId || '';
        const transcript = buildTranscript(context.chat, !!settings().skipSystemMessages);

        if (!transcript.trim()) {
            toastr.error('No messages to summarize');
            return '';
        }

        toastr.info('Generating chronology…', 'Chat Compressor');
        let chronology = await generateChronology(transcript);
        if (!chronology) {
            toastr.error('Empty chronology from the model');
            return '';
        }

        chronology = await reviewChronologyPopup(chronology);
        if (!chronology) {
            toastr.info('Compression cancelled');
            return '';
        }

        if (settings().factsEnabled && characterKey) {
            toastr.info('Updating user facts…', 'Chat Compressor');
            const existing = await loadFacts(characterKey);
            const updated = await generateUpdatedFacts(transcript, existing.facts);
            if (updated.length) {
                const doc = await saveFacts(characterKey, updated, sourceChat);
                applyFactsPrompt(doc);
                await syncFactsEditor(doc);
            } else {
                toastr.warning('Model returned no facts; keeping previous file');
            }
        }

        const deleteOld = await askDeleteOldChat();
        if (deleteOld === null) {
            toastr.info('New chat cancelled. Chronology was not applied.');
            return chronology;
        }

        await startNewChat(deleteOld);
        await injectChronologyAfterGreeting(chronology, sourceChat);
        await refreshFactsInjection();

        toastr.success('Chat compressed into a new conversation', 'Chat Compressor');
        return chronology;
    } catch (error) {
        console.error('[compressor]', error);
        toastr.error(String(error?.message || error), 'Chat Compressor failed');
        return '';
    } finally {
        busy = false;
        $('#compressor_settings').removeClass('compressor_busy');
    }
}

async function syncFactsEditor(doc = null) {
    const editor = $('#compressor_facts_editor');
    if (!editor.length) {
        return;
    }
    const characterKey = getCharacterKey();
    if (!characterKey) {
        editor.val('');
        return;
    }
    const data = doc || await loadFacts(characterKey);
    editor.val((data.facts || []).map(f => f.text).join('\n'));
}

function bindSettingsUi() {
    const s = settings();

    $('#compressor_facts_enabled').prop('checked', !!s.factsEnabled);
    $('#compressor_skip_system').prop('checked', !!s.skipSystemMessages);
    $('#compressor_response_length').val(Number(s.responseLength) || 0);
    $('#compressor_generation_mode').val(
        s.generationMode === GENERATION_MODES.CLASSIC ? GENERATION_MODES.CLASSIC : GENERATION_MODES.RAW,
    );
    $('#compressor_facts_depth').val(Number(s.factsDepth) || 0);
    $('#compressor_facts_position').val(String(s.factsPosition ?? EXTENSION_PROMPT_TYPES.BEFORE_PROMPT));
    $('#compressor_chrono_template').val(s.chronologyTemplate || DEFAULT_CHRONOLOGY_TEMPLATE);
    $('#compressor_chrono_prompt').val(s.chronoPrompt || DEFAULT_CHRONO_PROMPT);
    $('#compressor_facts_prompt').val(s.factsPrompt || DEFAULT_FACTS_PROMPT);
    $('#compressor_facts_template').val(s.factsTemplate || DEFAULT_FACTS_TEMPLATE);
    updateFactsUiVisibility();

    const persist = () => saveSettingsDebounced();

    $('#compressor_facts_enabled').off('input').on('input', async function () {
        s.factsEnabled = !!$(this).prop('checked');
        persist();
        updateFactsUiVisibility();
        await refreshFactsInjection();
    });

    $('#compressor_skip_system').off('input').on('input', function () {
        s.skipSystemMessages = !!$(this).prop('checked');
        persist();
    });

    $('#compressor_response_length').off('input').on('input', function () {
        s.responseLength = Number($(this).val()) || 0;
        persist();
    });

    $('#compressor_generation_mode').off('change').on('change', function () {
        s.generationMode = String($(this).val()) === GENERATION_MODES.CLASSIC
            ? GENERATION_MODES.CLASSIC
            : GENERATION_MODES.RAW;
        persist();
    });

    $('#compressor_facts_depth').off('input').on('input', async function () {
        s.factsDepth = Number($(this).val()) || 0;
        persist();
        await refreshFactsInjection();
    });

    $('#compressor_facts_position').off('change').on('change', async function () {
        s.factsPosition = Number($(this).val());
        persist();
        await refreshFactsInjection();
    });

    $('#compressor_chrono_template').off('input').on('input', function () {
        s.chronologyTemplate = String($(this).val());
        persist();
    });

    $('#compressor_chrono_prompt').off('input').on('input', function () {
        s.chronoPrompt = String($(this).val());
        persist();
    });

    $('#compressor_facts_prompt').off('input').on('input', function () {
        s.factsPrompt = String($(this).val());
        persist();
    });

    $('#compressor_facts_template').off('input').on('input', async function () {
        s.factsTemplate = String($(this).val());
        persist();
        await refreshFactsInjection();
    });

    $('#compressor_run_btn').off('click').on('click', () => {
        compressChat();
    });

    $('#compressor_facts_reload_btn').off('click').on('click', async () => {
        await syncFactsEditor();
        toastr.info('Facts reloaded');
    });

    $('#compressor_facts_save_btn').off('click').on('click', async () => {
        const characterKey = getCharacterKey();
        if (!characterKey) {
            toastr.error('Select a character first');
            return;
        }
        try {
            const lines = String($('#compressor_facts_editor').val() || '')
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean);
            const doc = await saveFacts(characterKey, lines);
            applyFactsPrompt(doc);
            toastr.success('Facts saved');
        } catch (error) {
            toastr.error(String(error?.message || error), 'Could not save facts');
        }
    });
}

function registerSlashCommand() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand } = context;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'compress',
        aliases: ['chatcompress', 'archivechat'],
        callback: async () => compressChat(),
        helpString: `
            <div>
                Compresses the current chat into a chronology (shown in an editable popup),
                updates persistent user facts, and starts a new chat.
                The character greeting stays first; chronology is added as the second message.
                You will be asked whether to delete the old chat.
            </div>
        `,
        returns: 'chronology text',
    }));
}

function registerEvents() {
    const context = ctx();
    const { eventSource, eventTypes } = context;

    const onContextChange = async () => {
        await refreshFactsInjection();
        await syncFactsEditor();
    };

    eventSource.on(eventTypes.CHAT_CHANGED, onContextChange);
    eventSource.on(eventTypes.CHAT_CREATED, onContextChange);
    if (eventTypes.CHARACTER_EDITED) {
        eventSource.on(eventTypes.CHARACTER_EDITED, onContextChange);
    }
}

async function addSettingsPanel() {
    let html = '';
    try {
        html = await renderExtensionTemplateAsync(EXTENSION_MOUNT, 'settings');
    } catch (error) {
        console.warn('[compressor] Template render failed, fetching settings.html directly', error);
        try {
            const response = await fetch(getSettingsHtmlUrl(), { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            html = await response.text();
        } catch (fetchError) {
            console.error('[compressor] settings.html missing next to index.js:', fetchError);
            toastr.error(
                `settings.html not found in ${EXTENSION_FOLDER}. Reinstall/update the extension.`,
                'Chat Compressor',
            );
            html = `
                <div class="compressor_settings" id="compressor_settings">
                    <div class="inline-drawer">
                        <div class="inline-drawer-toggle inline-drawer-header">
                            <b>Chat Compressor</b>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content">
                            <p><code>settings.html</code> is missing. Copy it next to <code>index.js</code> or reinstall the extension.</p>
                            <div class="compressor_actions">
                                <div id="compressor_run_btn" class="menu_button menu_button_icon">
                                    <i class="fa-solid fa-compress"></i>
                                    <span>Compress now</span>
                                </div>
                            </div>
                            <label class="checkbox_label" for="compressor_facts_enabled" style="display:none">
                                <input id="compressor_facts_enabled" type="checkbox" />
                            </label>
                            <input id="compressor_skip_system" type="checkbox" style="display:none" />
                            <input id="compressor_response_length" type="hidden" value="0" />
                            <input id="compressor_facts_depth" type="hidden" value="0" />
                            <select id="compressor_facts_position" style="display:none"><option value="2">2</option></select>
                            <textarea id="compressor_chrono_prompt" style="display:none"></textarea>
                            <textarea id="compressor_chrono_template" style="display:none"></textarea>
                            <textarea id="compressor_facts_prompt" style="display:none"></textarea>
                            <textarea id="compressor_facts_template" style="display:none"></textarea>
                            <textarea id="compressor_facts_editor" style="display:none"></textarea>
                            <div id="compressor_facts_reload_btn" style="display:none"></div>
                            <div id="compressor_facts_save_btn" style="display:none"></div>
                        </div>
                    </div>
                </div>
            `;
        }
    }

    if (!$('#compressor_settings').length) {
        $('#extensions_settings2').append(html);
    }
    bindSettingsUi();
    await syncFactsEditor();
}

/**
 * Extension activate hook.
 */
export async function init() {
    loadSettings();
    await addSettingsPanel();
    registerSlashCommand();
    registerEvents();
    await refreshFactsInjection();
    console.info('[compressor] Chat Compressor ready. Use /compress');
}
