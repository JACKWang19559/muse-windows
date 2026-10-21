# Streaming replies in 0.22

Short replies can appear while generation is still in progress, including when a long API key is configured. Earlier versions buffered a fixed amount of text for credential redaction, which could leave a short reply blank until the request finished.

The stream now retains a suffix only while it could form the configured credential in literal or JSON-escaped text. A bounded comparison budget falls back to conservative buffering for unusually repetitive credentials. Complete credential matches remain redacted in text, tool arguments, results and errors. Stopping a reply preserves safe text and discards an ambiguous credential prefix.

Regression checks cover every split of literal, escaped and mixed spellings, individual Unicode code units, cancellation, ordinary prefix mismatches and the conservative fallback. This changes local display timing; provider response times still depend on the configured service.
