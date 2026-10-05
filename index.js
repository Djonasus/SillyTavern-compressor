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
const DEFAULT_RAW_PREFILL = 'Chronology:\n-';
const DEFAULT_POOL_PREFILL = '["';
const DEFAULT_POOL_PROMPT = [
    'OOC / System task only. Do NOT write in character. Do NOT continue the roleplay.',
    'From the NEW chat messages only, extract 1 or 2 concise chronology facts that are NOT already covered by the existing pool.',
    'Skip anything already stated or implied in the existing facts (same event, same decision, same location update).',
    'If the new messages add nothing new, output [] .',
    'Do not invent facts. Do not write dialogue or narration.',
    'Output ONLY a JSON array of 0-2 short strings, e.g. ["Fact one"] or []. No markdown fences.',
    '',
    'Existing chronology facts (do NOT repeat):',
    '{{pool}}',
    '',
    'New messages:',
    '{{transcript}}',
].join('\n');

const GENERATION_MODES = {
    CLASSIC: 'classic',
    RAW: 'raw',
};

/** Where to place the summary instruction relative to the transcript */
const INSTRUCTION_POSITIONS = {
    /** ST system role / systemPrompt — before transcript */
    SYSTEM: 'system',
    /** Inline at the very start of the prompt body */
    START: 'start',
    /** After the full transcript */
    END: 'end',
    /** After N transcript message blocks */
    AFTER_MESSAGES: 'after_messages',
};

const defaultSettings = {
    factsEnabled: false,
    skipSystemMessages: true,
    generationMode: GENERATION_MODES.RAW,
    instructionPosition: INSTRUCTION_POSITIONS.SYSTEM,
    instructionDepth: 0,
    /** Raw-mode completion prefill (steers textgen away from RP continuation) */
    rawPrefill: DEFAULT_RAW_PREFILL,
    responseLength: 0,
    factsDepth: 0,
    factsPosition: EXTENSION_PROMPT_TYPES.BEFORE_PROMPT,
    chronologyTemplate: DEFAULT_CHRONOLOGY_TEMPLATE,
    chronoPrompt: DEFAULT_CHRONO_PROMPT,
    factsPrompt: DEFAULT_FACTS_PROMPT,
    factsTemplate: DEFAULT_FACTS_TEMPLATE,
    /** Auto-extract 1–2 chronology facts every N messages. 0 = off */
    factInterval: 5,
    poolPrompt: DEFAULT_POOL_PROMPT,
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

    // Refresh stock pool prompt if the user still has the pre-dedupe default
    const legacyPoolPrompt = [
        'OOC / System task only. Do NOT write in character. Do NOT continue the roleplay.',
        'From the NEW chat messages, extract 1 or 2 concise chronology facts: what happened, who did what, important decisions, locations, unresolved threads.',
        'Do not repeat facts already in the pool. Do not invent facts. Do not write dialogue or narration.',
        'Output ONLY a JSON array of 1-2 short strings, e.g. ["Fact one","Fact two"]. No markdown fences.',
        '',
        'Existing chronology facts:',
        '{{pool}}',
        '',
        'New messages:',
        '{{transcript}}',
    ].join('\n');
    if (s.poolPrompt === legacyPoolPrompt) {
        s.poolPrompt = DEFAULT_POOL_PROMPT;
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

function updateInstructionDepthVisibility() {
    const root = $('#compressor_settings');
    if (!root.length) {
        return;
    }
    const showDepth = settings().instructionPosition === INSTRUCTION_POSITIONS.AFTER_MESSAGES;
    root.toggleClass('compressor_depth_off', !showDepth);
}

function normalizeInstructionPosition(value) {
    const allowed = Object.values(INSTRUCTION_POSITIONS);
    return allowed.includes(value) ? value : INSTRUCTION_POSITIONS.SYSTEM;
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

function isCountableMessage(message, skipSystem) {
    if (!message?.mes || !String(message.mes).trim()) {
        return false;
    }
    if (message.extra?.compressor) {
        return false;
    }
    if (skipSystem && message.is_system) {
        return false;
    }
    return true;
}

function countableMessages(chat = ctx().chat) {
    const skipSystem = !!settings().skipSystemMessages;
    return (chat || []).filter(message => isCountableMessage(message, skipSystem));
}

function getPluginMeta() {
    const context = ctx();
    const metadata = context.chatMetadata;
    if (!metadata || typeof metadata !== 'object') {
        throw new Error('Chat metadata is not available');
    }
    if (!metadata[METADATA_KEY] || typeof metadata[METADATA_KEY] !== 'object') {
        metadata[METADATA_KEY] = {};
    }
    const meta = metadata[METADATA_KEY];
    if (!Array.isArray(meta.pool)) {
        meta.pool = [];
    }
    return meta;
}

async function ensurePoolInitialized(save = false) {
    const meta = getPluginMeta();
    if (typeof meta.processedCount !== 'number' || meta.processedCount < 0) {
        meta.processedCount = countableMessages().length;
        if (save) {
            try {
                await ctx().saveMetadata();
            } catch (error) {
                console.warn('[compressor] Failed to init pool metadata:', error);
            }
        }
    }
    return meta;
}

function formatPoolAsChronology(pool) {
    return (pool || [])
        .map(item => {
            const text = typeof item === 'string' ? item : item?.text;
            return String(text || '').trim();
        })
        .filter(Boolean)
        .map(text => (text.startsWith('- ') ? text : `- ${text}`))
        .join('\n');
}

async function savePool(pool, processedCount) {
    const context = ctx();
    const meta = getPluginMeta();
    meta.pool = (pool || [])
        .map(item => {
            if (typeof item === 'string') {
                return { id: context.uuidv4(), text: item.trim() };
            }
            return {
                id: item.id || context.uuidv4(),
                text: String(item.text || '').trim(),
            };
        })
        .filter(item => item.text);
    if (typeof processedCount === 'number') {
        meta.processedCount = processedCount;
    }
    await context.saveMetadata();
    return meta;
}

function sliceUnprocessedMessages(force) {
    const skipSystem = !!settings().skipSystemMessages;
    const chat = ctx().chat || [];
    const counted = [];
    for (const message of chat) {
        if (isCountableMessage(message, skipSystem)) {
            counted.push(message);
        }
    }
    const meta = getPluginMeta();
    const processedCount = Math.min(meta.processedCount || 0, counted.length);
    let slice = counted.slice(processedCount);
    if (!slice.length && force) {
        const interval = Math.max(1, Number(settings().factInterval) || 5);
        slice = counted.slice(-interval);
    }
    return { slice, counted, processedCount };
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
 * Normalize fact text for duplicate detection.
 * @param {string} text
 * @returns {string}
 */
function normalizeFactText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/^[-*•\d.)\s]+/, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Drop facts that already exist in the pool (exact or near-duplicate).
 * @param {string[]} candidates
 * @param {{ text?: string }[]|string[]} existingPool
 * @returns {string[]}
 */
function dedupeFactsAgainstPool(candidates, existingPool = []) {
    const existingNorms = (existingPool || [])
        .map(item => normalizeFactText(typeof item === 'string' ? item : item?.text))
        .filter(Boolean);

    const accepted = [];
    const acceptedNorms = [];

    for (const candidate of candidates || []) {
        const text = String(candidate || '').trim();
        const norm = normalizeFactText(text);
        if (!norm) {
            continue;
        }

        const isDup = [...existingNorms, ...acceptedNorms].some(other => {
            if (norm === other) {
                return true;
            }
            // Soft match: one fact fully contains the other (same event, longer wording)
            if (norm.length >= 12 && other.length >= 12) {
                return norm.includes(other) || other.includes(norm);
            }
            return false;
        });

        if (isDup) {
            continue;
        }

        accepted.push(text);
        acceptedNorms.push(norm);
    }

    return accepted;
}

function formatPoolForPrompt(existingPool) {
    if (!existingPool?.length) {
        return '(none)';
    }
    return existingPool
        .map(f => `- ${typeof f === 'string' ? f : (f.text || '')}`)
        .map(line => line.trim())
        .filter(line => line !== '-')
        .join('\n') || '(none)';
}

/**
 * Split a templated prompt into instruction + transcript blocks.
 * @param {string} promptTemplate
 * @param {string} transcript
 * @returns {{ instruction: string, blocks: string[], classicPrompt: string }}
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

    let instruction = template
        .replaceAll('{{transcript}}', '')
        .replaceAll('{transcript}', '')
        .replace(/\n*Chat transcript:\s*$/i, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    instruction = applyTemplate(instruction || template, {});
    if (!instruction.trim()) {
        instruction = 'Summarize the chat transcript. Output only the summary.';
    }

    const blocks = String(transcript || '')
        .split(/\n\n+/)
        .map(b => b.trim())
        .filter(Boolean);

    return {
        instruction,
        blocks,
        classicPrompt,
    };
}

/**
 * Place the summary instruction relative to transcript blocks.
 * @param {string} instruction
 * @param {string[]} blocks
 * @returns {{ systemPrompt: string, prompt: string | object[] }}
 */
function placeInstruction(instruction, blocks) {
    const s = settings();
    const position = s.instructionPosition || INSTRUCTION_POSITIONS.SYSTEM;
    const depth = Math.max(0, Number(s.instructionDepth) || 0);
    const transcriptText = blocks.join('\n\n');

    if (position === INSTRUCTION_POSITIONS.END) {
        return {
            systemPrompt: '',
            prompt: transcriptText
                ? `${transcriptText}\n\n${instruction}`
                : instruction,
        };
    }

    if (position === INSTRUCTION_POSITIONS.START) {
        return {
            systemPrompt: '',
            prompt: transcriptText
                ? `${instruction}\n\n${transcriptText}`
                : instruction,
        };
    }

    if (position === INSTRUCTION_POSITIONS.AFTER_MESSAGES) {
        const n = Math.min(depth, blocks.length);
        const merged = [
            ...blocks.slice(0, n),
            instruction,
            ...blocks.slice(n),
        ].join('\n\n');
        return {
            systemPrompt: '',
            prompt: merged || instruction,
        };
    }

    // SYSTEM (default): instruction as systemPrompt, transcript as user content
    return {
        systemPrompt: instruction,
        prompt: transcriptText || '(empty transcript)',
    };
}

/**
 * @param {string} promptTemplate Templated instruction (may include {{transcript}})
 * @param {string} transcript Chat transcript
 * @param {number} [responseLength]
 * @param {{ prefill?: string }} [options]
 * @returns {Promise<string>}
 */
async function generateText(promptTemplate, transcript, responseLength = 0, options = {}) {
    const context = ctx();
    const mode = settings().generationMode === GENERATION_MODES.CLASSIC
        ? GENERATION_MODES.CLASSIC
        : GENERATION_MODES.RAW;
    const { instruction, blocks, classicPrompt } = buildGenerationPrompts(promptTemplate, transcript);
    const placed = placeInstruction(instruction, blocks);

    if (mode === GENERATION_MODES.RAW) {
        if (typeof context.generateRaw !== 'function') {
            toastr.warning('generateRaw unavailable; falling back to Classic');
        } else {
            const prefill = options.prefill !== undefined
                ? String(options.prefill)
                : String(settings().rawPrefill ?? DEFAULT_RAW_PREFILL);
            const params = {
                prompt: placed.prompt,
                systemPrompt: placed.systemPrompt,
                // Prevent Instruct from appending a character turn ( Magnum continues RP otherwise )
                instructOverride: true,
                quietToLoud: false,
                prefill,
            };
            if (responseLength > 0) {
                params.responseLength = responseLength;
            }
            const result = await context.generateRaw(params);
            return String(result || '').trim();
        }
    }

    // Classic: rebuild quiet prompt with the same placement rules
    const classicPlaced = placed.systemPrompt
        ? `${placed.systemPrompt}\n\n${typeof placed.prompt === 'string' ? placed.prompt : classicPrompt}`
        : (typeof placed.prompt === 'string' ? placed.prompt : classicPrompt);

    const params = {
        quietPrompt: classicPlaced,
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

async function generatePoolFacts(transcript, existingPool) {
    const s = settings();
    const existing = formatPoolForPrompt(existingPool);

    // Ensure the active prompt can receive the pool even if the user edited it out
    let promptTemplate = s.poolPrompt || DEFAULT_POOL_PROMPT;
    if (!promptTemplate.includes('{{pool}}') && !promptTemplate.includes('{pool}')) {
        promptTemplate = [
            promptTemplate.trim(),
            '',
            'Existing chronology facts (do NOT repeat):',
            '{{pool}}',
        ].join('\n');
    }
    promptTemplate = applyTemplate(promptTemplate, { pool: existing });

    // Also put the pool into the user/transcript side so Raw models that
    // under-attend system prompts still see prior facts.
    const transcriptWithPool = [
        'Existing chronology facts (do NOT repeat or rephrase):',
        existing,
        '',
        'New messages only (extract NEW facts from these):',
        transcript,
    ].join('\n');

    const raw = await generateText(
        promptTemplate,
        transcriptWithPool,
        Number(s.responseLength) || 0,
        { prefill: DEFAULT_POOL_PREFILL },
    );
    const parsed = parseFactsFromModel(raw).slice(0, 2);
    return {
        parsed,
        unique: dedupeFactsAgainstPool(parsed, existingPool),
    };
}

/**
 * Extract 1–2 chronology facts from new messages and append them to the chat pool.
 * @param {{ force?: boolean, silent?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
async function extractFactsToPool(options = {}) {
    const { force = false, silent = false } = options;
    if (busy) {
        if (!silent) {
            toastr.warning('Compressor is busy');
        }
        return [];
    }

    const context = ctx();
    if (context.groupId) {
        if (!silent && force) {
            toastr.error('Chat Compressor does not support group chats yet');
        }
        return [];
    }
    if (context.characterId === undefined || context.characterId === null) {
        if (!silent && force) {
            toastr.error('Select a character first');
        }
        return [];
    }
    if (context.onlineStatus === 'no_connection') {
        if (!silent && force) {
            toastr.error('API is not connected');
        }
        return [];
    }

    await ensurePoolInitialized(true);
    const { slice, counted } = sliceUnprocessedMessages(force);
    if (!slice.length) {
        if (!silent && force) {
            toastr.info('No new messages to extract facts from');
        }
        return [];
    }

    const transcript = buildTranscript(slice, !!settings().skipSystemMessages);
    if (!transcript.trim()) {
        if (!silent && force) {
            toastr.info('No new messages to extract facts from');
        }
        return [];
    }

    busy = true;
    $('#compressor_settings').addClass('compressor_busy');
    try {
        if (!silent) {
            toastr.info('Extracting chronology facts…', 'Chat Compressor');
        }
        const meta = getPluginMeta();
        const { parsed, unique: facts } = await generatePoolFacts(transcript, meta.pool || []);
        if (!parsed.length) {
            // Model returned nothing useful — keep progress so a later /fact can retry
            if (!silent) {
                toastr.warning('Model returned no chronology facts');
            }
            return [];
        }
        if (!facts.length) {
            // Everything was already in the pool — advance so we don't loop on the same slice
            await savePool(meta.pool, counted.length);
            if (!silent) {
                toastr.info('No new chronology facts (duplicates skipped)', 'Chat Compressor');
            }
            return [];
        }

        const merged = [...(meta.pool || []), ...facts];
        await savePool(merged, counted.length);
        await syncPoolEditor();
        if (!silent) {
            toastr.success(`Added ${facts.length} chronology fact(s)`, 'Chat Compressor');
        }
        return facts;
    } catch (error) {
        console.error('[compressor] Fact extraction failed:', error);
        if (!silent) {
            toastr.error(String(error?.message || error), 'Fact extraction failed');
        }
        return [];
    } finally {
        busy = false;
        $('#compressor_settings').removeClass('compressor_busy');
    }
}

async function maybeAutoExtractFacts() {
    if (busy) {
        return;
    }
    const interval = Math.max(0, Number(settings().factInterval) || 0);
    if (interval <= 0) {
        return;
    }
    const context = ctx();
    if (context.groupId || context.characterId === undefined || context.characterId === null) {
        return;
    }
    if (context.onlineStatus === 'no_connection') {
        return;
    }
    try {
        await ensurePoolInitialized(true);
        const { slice } = sliceUnprocessedMessages(false);
        if (slice.length < interval) {
            return;
        }
        await extractFactsToPool({ force: false, silent: true });
    } catch (error) {
        console.warn('[compressor] Auto fact extraction skipped:', error);
    }
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
    const context = ctx();
    const s = settings();
    const template = s.chronologyTemplate || DEFAULT_CHRONOLOGY_TEMPLATE;
    const summary = chronologyText.trim();
    let mes = applyTemplate(template, { summary });

    // If template forgot the placeholder, append the summary
    if (!template.includes('{{summary}}') && !template.includes('{summary}')) {
        mes = `${mes}\n${summary}`.trim();
    }

    const character = context.characters?.[context.characterId];
    // Visible character-side message (not is_system / ghost) so it stays in the chat UI
    return {
        name: character?.name || 'Chronology',
        is_user: false,
        is_system: false,
        force_avatar: character?.avatar || undefined,
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
        pool: [],
        processedCount: countableMessages().length,
    };
    await context.saveMetadata();
    await context.saveChat();
}

/**
 * Main compress pipeline.
 * @param {{ usePool?: boolean }} [options] usePool=true assembles the fact pool;
 *   usePool=false runs the legacy full-chat chronology summary.
 * @returns {Promise<string>} Chronology text
 */
async function compressChat(options = {}) {
    const { usePool = true } = options;

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

    // Flush any unprocessed messages into the pool before assembling
    if (usePool) {
        await extractFactsToPool({ force: false, silent: true });
        if (busy) {
            toastr.warning('Compression already in progress');
            return '';
        }
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

        let chronology = '';

        if (usePool) {
            await ensurePoolInitialized(true);
            chronology = formatPoolAsChronology(getPluginMeta().pool);
            if (chronology) {
                toastr.info('Assembling chronology from fact pool…', 'Chat Compressor');
            } else {
                toastr.info('Fact pool is empty; generating chronology from the transcript…', 'Chat Compressor');
                chronology = await generateChronology(transcript);
            }
        } else {
            toastr.info('Generating full-chat chronology…', 'Chat Compressor');
            chronology = await generateChronology(transcript);
        }

        if (!chronology) {
            toastr.error('Empty chronology');
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

async function syncPoolEditor() {
    const editor = $('#compressor_pool_editor');
    if (!editor.length) {
        return;
    }
    try {
        const meta = await ensurePoolInitialized(false);
        editor.val((meta.pool || []).map(f => f.text).join('\n'));
    } catch {
        editor.val('');
    }
}

function poolLinesFromText(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => line.replace(/^[-*•]\s+/, '').trim())
        .filter(Boolean);
}

/**
 * Open an editable popup for the current chat's chronology fact pool.
 * @returns {Promise<string[]|null>} Saved lines, or null if cancelled
 */
async function editPoolPopup() {
    const context = ctx();
    if (context.groupId) {
        toastr.error('Chat Compressor does not support group chats yet');
        return null;
    }

    let meta;
    try {
        meta = await ensurePoolInitialized(true);
    } catch (error) {
        toastr.error(String(error?.message || error), 'Could not load fact pool');
        return null;
    }

    const current = (meta.pool || []).map(f => f.text).join('\n');
    const edited = await context.Popup.show.input(
        'Edit chronology facts',
        'One fact per line for this chat. Empty clears the pool. Cancel discards changes.',
        current,
        {
            rows: 16,
            wide: true,
            large: true,
            okButton: 'Save',
            cancelButton: 'Cancel',
            allowVerticalScrolling: true,
        },
    );

    if (edited === null) {
        return null;
    }

    const lines = poolLinesFromText(edited);
    try {
        const counted = countableMessages();
        await savePool(lines, counted.length);
        await syncPoolEditor();
        toastr.success(
            lines.length ? `Saved ${lines.length} chronology fact(s)` : 'Chronology pool cleared',
            'Chat Compressor',
        );
        return lines;
    } catch (error) {
        toastr.error(String(error?.message || error), 'Could not save pool');
        return null;
    }
}

function bindSettingsUi() {
    const s = settings();

    $('#compressor_facts_enabled').prop('checked', !!s.factsEnabled);
    $('#compressor_skip_system').prop('checked', !!s.skipSystemMessages);
    $('#compressor_response_length').val(Number(s.responseLength) || 0);
    $('#compressor_generation_mode').val(
        s.generationMode === GENERATION_MODES.CLASSIC ? GENERATION_MODES.CLASSIC : GENERATION_MODES.RAW,
    );
    $('#compressor_instruction_position').val(normalizeInstructionPosition(s.instructionPosition));
    $('#compressor_instruction_depth').val(Number(s.instructionDepth) || 0);
    $('#compressor_raw_prefill').val(s.rawPrefill ?? DEFAULT_RAW_PREFILL);
    $('#compressor_facts_depth').val(Number(s.factsDepth) || 0);
    $('#compressor_facts_position').val(String(s.factsPosition ?? EXTENSION_PROMPT_TYPES.BEFORE_PROMPT));
    $('#compressor_chrono_template').val(s.chronologyTemplate || DEFAULT_CHRONOLOGY_TEMPLATE);
    $('#compressor_chrono_prompt').val(s.chronoPrompt || DEFAULT_CHRONO_PROMPT);
    $('#compressor_pool_prompt').val(s.poolPrompt || DEFAULT_POOL_PROMPT);
    $('#compressor_fact_interval').val(Number(s.factInterval) ?? 5);
    $('#compressor_facts_prompt').val(s.factsPrompt || DEFAULT_FACTS_PROMPT);
    $('#compressor_facts_template').val(s.factsTemplate || DEFAULT_FACTS_TEMPLATE);
    updateFactsUiVisibility();
    updateInstructionDepthVisibility();

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

    $('#compressor_instruction_position').off('change').on('change', function () {
        s.instructionPosition = normalizeInstructionPosition(String($(this).val()));
        persist();
        updateInstructionDepthVisibility();
    });

    $('#compressor_instruction_depth').off('input').on('input', function () {
        s.instructionDepth = Math.max(0, Number($(this).val()) || 0);
        persist();
    });

    $('#compressor_raw_prefill').off('input').on('input', function () {
        s.rawPrefill = String($(this).val());
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

    $('#compressor_pool_prompt').off('input').on('input', function () {
        s.poolPrompt = String($(this).val());
        persist();
    });

    $('#compressor_fact_interval').off('input').on('input', function () {
        s.factInterval = Math.max(0, Number($(this).val()) || 0);
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
        compressChat({ usePool: true });
    });

    $('#compressor_run_full_btn').off('click').on('click', () => {
        compressChat({ usePool: false });
    });

    $('#compressor_fact_btn').off('click').on('click', () => {
        extractFactsToPool({ force: true, silent: false });
    });

    $('#compressor_edit_pool_btn').off('click').on('click', () => {
        editPoolPopup();
    });

    $('#compressor_pool_reload_btn').off('click').on('click', async () => {
        await syncPoolEditor();
        toastr.info('Chronology pool reloaded');
    });

    $('#compressor_pool_save_btn').off('click').on('click', async () => {
        try {
            const counted = countableMessages();
            const lines = poolLinesFromText($('#compressor_pool_editor').val());
            await savePool(lines, counted.length);
            toastr.success(
                lines.length ? `Saved ${lines.length} chronology fact(s)` : 'Chronology pool cleared',
            );
        } catch (error) {
            toastr.error(String(error?.message || error), 'Could not save pool');
        }
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
        callback: async () => compressChat({ usePool: true }),
        helpString: `
            <div>
                Assembles the chronology fact pool into a timeline (editable popup),
                optionally updates persistent user facts, and starts a new chat.
                The character greeting stays first; chronology is added as a visible second message.
                You will be asked whether to delete the old chat.
            </div>
        `,
        returns: 'chronology text',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'compressfull',
        aliases: ['fullcompress', 'summarizecompress'],
        callback: async () => compressChat({ usePool: false }),
        helpString: `
            <div>
                Legacy mode: summarize the entire chat transcript into a chronology in one call
                (same as the old <code>/compress</code>), then start a new chat.
                Prefer <code>/compress</code> when the fact pool is in use.
            </div>
        `,
        returns: 'chronology text',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fact',
        aliases: ['chatfact', 'chronofact'],
        callback: async () => {
            const facts = await extractFactsToPool({ force: true, silent: false });
            return facts.join('\n');
        },
        helpString: `
            <div>
                Extract 1–2 chronology facts from new messages and append them to the pool.
                Facts are assembled by <code>/compress</code> instead of a full-chat summary.
            </div>
        `,
        returns: 'extracted facts',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'editpool',
        aliases: ['pool', 'editfacts', 'chronopool'],
        callback: async () => {
            const lines = await editPoolPopup();
            return lines ? lines.join('\n') : '';
        },
        helpString: `
            <div>
                Open an editable popup for this chat’s chronology fact pool (one fact per line).
                Also available in extension settings and via the <b>Edit pool</b> button.
            </div>
        `,
        returns: 'saved pool text',
    }));
}

function registerEvents() {
    const context = ctx();
    const { eventSource, eventTypes } = context;

    const onContextChange = async () => {
        await ensurePoolInitialized(true);
        await refreshFactsInjection();
        await syncFactsEditor();
        await syncPoolEditor();
    };

    const onNewMessage = () => {
        delay(150).then(() => maybeAutoExtractFacts());
    };

    eventSource.on(eventTypes.CHAT_CHANGED, onContextChange);
    eventSource.on(eventTypes.CHAT_CREATED, onContextChange);
    if (eventTypes.CHARACTER_EDITED) {
        eventSource.on(eventTypes.CHARACTER_EDITED, onContextChange);
    }
    if (eventTypes.MESSAGE_RECEIVED) {
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onNewMessage);
    }
    if (eventTypes.MESSAGE_SENT) {
        eventSource.on(eventTypes.MESSAGE_SENT, onNewMessage);
    }
    if (eventTypes.MESSAGE_DELETED) {
        eventSource.on(eventTypes.MESSAGE_DELETED, async () => {
            const meta = getPluginMeta();
            const n = countableMessages().length;
            if ((meta.processedCount || 0) > n) {
                meta.processedCount = n;
                try {
                    await ctx().saveMetadata();
                } catch (error) {
                    console.warn('[compressor] Failed to clamp pool progress:', error);
                }
            }
        });
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
                                <div id="compressor_run_full_btn" style="display:none"></div>
                                <div id="compressor_fact_btn" style="display:none"></div>
                                <div id="compressor_edit_pool_btn" style="display:none"></div>
                            </div>
                            <label class="checkbox_label" for="compressor_facts_enabled" style="display:none">
                                <input id="compressor_facts_enabled" type="checkbox" />
                            </label>
                            <input id="compressor_skip_system" type="checkbox" style="display:none" />
                            <input id="compressor_response_length" type="hidden" value="0" />
                            <input id="compressor_facts_depth" type="hidden" value="0" />
                            <input id="compressor_fact_interval" type="hidden" value="5" />
                            <select id="compressor_facts_position" style="display:none"><option value="2">2</option></select>
                            <textarea id="compressor_chrono_prompt" style="display:none"></textarea>
                            <textarea id="compressor_chrono_template" style="display:none"></textarea>
                            <textarea id="compressor_pool_prompt" style="display:none"></textarea>
                            <textarea id="compressor_pool_editor" style="display:none"></textarea>
                            <textarea id="compressor_facts_prompt" style="display:none"></textarea>
                            <textarea id="compressor_facts_template" style="display:none"></textarea>
                            <textarea id="compressor_facts_editor" style="display:none"></textarea>
                            <div id="compressor_pool_reload_btn" style="display:none"></div>
                            <div id="compressor_pool_save_btn" style="display:none"></div>
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
    await syncPoolEditor();
}

/**
 * Extension activate hook.
 */
export async function init() {
    loadSettings();
    await addSettingsPanel();
    registerSlashCommand();
    registerEvents();
    try {
        await ensurePoolInitialized(true);
        await syncPoolEditor();
    } catch (error) {
        console.warn('[compressor] Pool init skipped:', error);
    }
    await refreshFactsInjection();
    console.info('[compressor] Chat Compressor ready. Use /fact, /editpool, /compress, /compressfull');
}
