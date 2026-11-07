# Raw — free beta

[Open Raw in your browser](https://raw-private-beta.rawtags.chatgpt.site/) — no download and no email needed.

Your projects, prompts and community, with your own account. Use Raw in a browser on a phone, tablet, Mac or PC. The Windows app adds local models, recording, mail and reviewed development tools.

## Start here

Create a unique username and a strong password. No email is required. Then create a private workspace with a **different workspace passphrase**. Keep both safe: password and passphrase recovery are not available in this beta.

Save online before closing, then sign in on another device and open the saved workspace with its original passphrase. Export an encrypted backup regularly. A conflicting save is refused so one device cannot silently overwrite another. Older saved versions are retained within the beta limits.

## Included

- Projects and private notes in desktop-compatible encrypted workspaces.
- A free prompt builder that runs on your device without a model call or upload.
- Personal colours and reduced motion.
- Public posts, projects, questions and plain-text prompt/theme presets.
- One community coin per unique like, with no self-reward or duplicate reward. Coins have no monetary value and cannot be bought or cashed out.
- Invite-only group text, voluntary voice parties and friendly challenges.
- Quiet update messages and a separate owner moderation/publishing tool.

Browser model replies, local files, desktop recording and Roblox changes require further browser integration or the Windows app. Voice uses peer connections and public STUN discovery; some networks cannot connect. Coin stakes are disabled. Rich video/image feeds, full moderation operations, native phone/Mac installers and stronger account recovery are still being developed. This beta is not the full original Raw specification.

## Privacy, plainly

Workspace contents are encrypted in your browser before upload, using the same scrypt/AES-GCM format as the Windows app. The workspace passphrase is not sent to the service. Your account password is sent over HTTPS for sign-in; do not reuse it as the workspace passphrase. Keys remain in memory while a workspace is open. Hosted browser code and an unlocked device still need to be trusted.

Usernames, encrypted sizes and save times are service-visible. Public posts and group text are service-readable. Voice connection metadata is short-lived, and peers/STUN discovery can see network addresses. No automatic microphone or screen capture, private-data training or model calls are included. These are specific protections, not a promise of perfect privacy or an independent security certification.

Accounts use salted password verifiers and hashed, revocable sessions. Browser cookies are HttpOnly, Secure and SameSite, with server-side origin and ownership checks. The current Worker password work factor needs further hardening and independent review before a broad public launch.

## Beta limits and progress

Current safeguards include 10 workspaces and 100 retained versions per workspace, 128 MiB of encrypted versions per account, and a 512 MiB overall encrypted-workspace beta cap. Registration and posting also have limits. Reaching a limit refuses the new operation rather than deleting saved progress. These are protective beta limits, not evidence of large-scale capacity. Backups exported to your own storage provide an additional recovery copy; the account/encrypted-version service backup has a separate privileged export and restore workflow. Social posts, coins, groups and challenges are not included in that service backup.

The installer contains no founder account, conversations, databases, backups, publisher keys or model-provider credentials. Never share your `.rawbackup` file as though it were the installer.

## Development

This repository contains the browser beta and its account service. It uses Vinext, a Worker, durable D1 metadata and opaque R2 objects. `hosting.example.json` shows placeholder hosting bindings. Create your own private `.openai/hosting.json` through your authorised hosting setup; the founder’s live project identity is not included. Keep platform sign-in routes and access controls intact. `RAW_OPERATOR_KEY` and the separate `RAW_BACKUP_KEY` are server-only runtime secrets; never put it in source, the browser, an installer or a screenshot. Owning the first account gives no administrator rights.

Install the pinned dependencies with `npm ci`, run `npm run db:generate` after schema changes, apply schema-only migrations to a disposable local database, and build with `npm run build`. Server tests use real local SQLite and controlled storage faults. Cross-runtime and hidden Electron tests additionally require the separate Windows desktop source/runtime and are not standalone tests in this browser-only repository. These checks do not replace hosted verification. Test artefacts, credentials and local runtime state are excluded from source publication.

Raw source is shared for beta review; it has not been relicensed. Third-party dependencies keep their own licences. Do not copy private data into issues or post security exploit details publicly.
