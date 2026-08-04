# Security policy

## Supported versions

The latest published minor release receives fixes. Older versions are not patched retroactively; upgrading is the fix.

## Reporting a vulnerability

Please do not open a public issue for anything exploitable. Instead:

1. Use GitHub's private vulnerability reporting on this repository ("Report a vulnerability" under the Security tab), or
2. Contact the maintainer directly: [github.com/nirholas](https://github.com/nirholas).

Include reproduction steps and impact. You will get an acknowledgment, and a fix or a documented decision, as fast as the maintainer can reasonably move.

## Threat model notes for operators

- **The bot token is the only secret.** It lives in `.env` or your process manager's environment, is never logged, and never appears in `doctor` output. Rotate it via @BotFather if it leaks.
- **The bot holds no funds and signs nothing.** It is read-only against the chain: it sends no transactions and has no keys. The worst case of a compromised deployment is spam from your bot, not lost assets.
- **Token names are hostile input.** Anything read from the chain (symbols, names) is HTML-escaped before rendering into Telegram cards; a token named `<script>` stays text.
- **Alert content is informational only.** Cards report on-chain facts; nothing in this project executes trades on anyone's behalf.

## Dependency advisories

`npm audit` findings against the published package are triaged for real-world reachability, not just suppressed. Advisories that cannot be fixed downstream (they originate in a dependency's own pinned dependencies) are documented rather than hidden.
