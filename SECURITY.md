# Security policy

Report suspected vulnerabilities through GitHub's **Report a vulnerability** control when private vulnerability reporting is available. Do not include credentials, confidential documents, or exploit details in public issues. If private reporting is unavailable, contact the maintainer privately and wait before sharing sensitive details.

## Deployment boundary

The API binds to `127.0.0.1` by default. Its CORS allowlist controls which browser origins may call it; CORS is not authentication. This version does not implement an API bearer-token setting. Do not expose the API directly to the public internet. For remote use, put it behind a TLS reverse proxy or private network that authenticates users and restricts access to the API.

Document content and model output are untrusted. Conversion size and page limits do not replace operating-system isolation. A shared or remote API should run with a dedicated low-privilege account in a resource-limited worker/container, and should disable Codex App Server unless the host's Codex account is intended for every API user. Configure `CORS_ALLOWED_ORIGINS` with only the exact application origins in use.

The optional “remember API key” setting stores the provider key in browser local storage on that device. Leave it off on shared devices. Local server session records are encrypted at rest, but temporary uploads and active processing still pass through server memory and temporary conversion files.

The repository does not publish packages or releases automatically and does not require publishing credentials in GitHub Actions. Review dependency and security alerts before releases.
