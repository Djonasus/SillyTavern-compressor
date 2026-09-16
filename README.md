# Chat Compressor (SillyTavern extension)

Compresses long chats so context stays small and generation stays fast.

## What it does

1. Run `/compress` (or the **Compress now** button in extension settings).
2. The current API model writes a **chronology** of the chat (**Raw** mode by default: no character card / chat context; switch to Classic in settings if needed).
3. A **popup** shows the chronology so you can edit it before continuing (Cancel aborts).
4. Optionally extracts/updates **user facts** and stores them in a separate file under `data/<user>/user/files/compressor-facts-<character>.json`.
5. Asks whether to **delete** the old chat.
6. Opens a **new chat**: first message = character greeting, second = chronology (`is_system`).
7. Facts are injected into the prompt on every chat with that character via `setExtensionPrompt`.

## Install

Copy or symlink this folder into one of:

- `SillyTavern/public/scripts/extensions/third-party/compressor` (all users)
- `SillyTavern/data/default-user/extensions/compressor` (current user)

Then enable **Chat Compressor** in Extensions and refresh.

## Usage

```
/compress
```

Edit prompts, facts injection, and the facts list in **Extensions → Chat Compressor**.

## Notes

- Group chats are not supported in v1.
- Built-in Summarize does not remove messages; this extension resets the chat file while keeping a timeline + durable facts.
