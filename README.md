# Chat Compressor (SillyTavern extension)

Compresses long chats so context stays small and generation stays fast.

## What it does

1. While you chat, every **N messages** (default 5) the current API model extracts **1–2 chronology facts** into a per-chat pool. You can also run **`/fact`** (or **Extract facts now**) at any time, or edit the pool manually with **`/editpool`** / **Edit pool**.
2. Run `/compress` (or **Compress (pool)**). Pending facts are flushed first, then the pool is **assembled** into a chronology (no extra full-chat summary call unless the pool is empty). A **popup** lets you edit it before continuing (Cancel aborts).
3. Optionally extracts/updates **user facts** and stores them in a separate file under `data/<user>/user/files/compressor-facts-<character>.json`.
4. Asks whether to **delete** the old chat.
5. Opens a **new chat**: first message = character greeting, second = chronology as a **visible** character message, third = the **last message** from the previous chat (so the scene can continue).
6. Persistent user facts are injected into the prompt on every chat with that character via `setExtensionPrompt`.

**Legacy:** `/compressfull` (or **Compress (full summary)**) still does a one-shot full-chat chronology summary, like the old `/compress`.

## Install

Copy or symlink this folder into one of:

- `SillyTavern/public/scripts/extensions/third-party/compressor` (all users)
- `SillyTavern/data/default-user/extensions/compressor` (current user)

Then enable **Chat Compressor** in Extensions and refresh.

## Usage

```
/fact
/editpool
/compress
/compressfull
```

Edit prompts, the fact interval, the chronology pool, facts injection, and the user-facts list in **Extensions → Chat Compressor**. Set the interval to `0` to disable auto-extraction.

## Notes

- Group chats are not supported in v1.
- Built-in Summarize does not remove messages; this extension resets the chat file while keeping a timeline + durable facts.
