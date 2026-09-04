# Private media sidecar HTTP/JSON v1

This is a private localhost/container protocol. It is not a public API and does not generate clients. Every body is UTF-8 JSON with `Content-Type: application/json`; unknown fields are rejected. No fixture contains cookies, signed URLs, query secrets, or real upstream data.

## Endpoints, bounds, and strict shapes

`GET /healthz` returns exactly `{"version":1,"status":"ok"}`. `POST /v1/search` accepts exactly `{"version":1,"query":"..."}`. `POST /v1/resolve` accepts exactly `{"version":1,"track":{"id":"...","url":"https://www.youtube.com/watch?v=<same-id>"}}`. IDs are `[A-Za-z0-9_-]{1,128}` and equality is byte-for-byte after extracting `v`; a mismatch is 400.

Requests are capped at 16 KiB. Sidecar and Innertube bodies are capped at 1 MiB; yt-dlp stdout/stderr are capped at 4 MiB/64 KiB. Search inspects raw renderer ordinals 0 through 4 only and returns at most five results. A malformed renderer consumes an ordinal: the ordinal fixture has malformed slot 0, then valid slots 1 through 4 at scores `0.9`, `0.8`, `0.7`, and `0.6`; slot 5 is omitted. Concatenated title and artist runs use ECMAScript trimming, reject an empty post-trim value, and are limited to 512 Unicode code points, matching Node `TrackSchema`. Every thumbnail candidate must be a URL, but artwork remains metadata and may use any scheme accepted by Node URL validation. Rust allows four extractor permits; shadow tracks at most 32 calls. Rust search/resolve deadlines are 2.5/20 seconds; Node deadlines are 3/21 seconds; shutdown drains for at most 10 seconds.

Search success is exactly `{"version":1,"results":[{"track":Track,"score":number,"bitrateKbps":number|null}]}`. Resolve success is exactly `{"version":1,"media":{"kind":"remote","url":string,"headers":object,"container":string,"codec":string,"bitrateKbps":number|null,"seekable":true}}`. `Track` has exactly `id`, `provider:"youtube"`, `title`, `artist`, canonical equal `url`, non-negative integer `durationMs`, and `artworkUrl`.

Every error envelope has exactly `version` and `error.code`. The canonical fixtures lock 400/`invalid_request`, 413/`payload_too_large`, 415/`unsupported_media_type`, 429/`busy`, 500/`internal`, 502/`extractor_failed`, and 504/`deadline_exceeded`. In particular, 413 is exactly `{"version":1,"error":{"code":"payload_too_large"}}` and 415 is exactly `{"version":1,"error":{"code":"unsupported_media_type"}}`.

## Cause, status, Node result, fallback, and state

| Cause | Rust HTTP/code | Node typed result | Fallback | State |
| --- | --- | --- | --- | --- |
| Valid strict response | 200/no error | domain result | no | ready |
| Invalid request or ID/URL mismatch | 400/invalid_request | SidecarInvalidRequestError | no | degraded |
| Body above 16 KiB | 413/payload_too_large | SidecarRequestRejectedError | no | degraded |
| Non-JSON content type | 415/unsupported_media_type | SidecarRequestRejectedError | no | degraded |
| No extractor permit | 429/busy | SidecarOverloadedError | yes, once in rust mode | degraded |
| Innertube or yt-dlp valid failure | 502/extractor_failed | SidecarExtractorError | no | degraded |
| Innertube redirect | 502/extractor_failed | SidecarExtractorError | no | degraded |
| Rust deadline | 504/deadline_exceeded | SidecarDeadlineError | yes, once in rust mode | degraded |
| Node deadline | transport aborted | SidecarClientDeadlineError | yes, once in rust mode | degraded |
| Sanitized Rust internal failure | 500/internal | SidecarInternalError | yes, once in rust mode | degraded |
| Refused reset or DNS transport | no trusted Rust response | SidecarUnavailableError | yes, once in rust mode | degraded |
| Malformed version-skew unsafe or oversized response | no trusted Rust response | SidecarProtocolError | yes, once in rust mode | degraded |
| Sidecar redirect response | redirect rejected | SidecarProtocolError | yes, once in rust mode | degraded |
| Caller request abort | no required Rust response | AbortError | unchanged | unchanged |
| Shadow comparison mismatch | 200 | local result plus sanitized mismatch event | local authoritative | degraded |
| Shadow capacity 32 reached | no Rust call | local result plus shadow skipped event | local authoritative | degraded |
| Any later valid sidecar success | 200/no error | domain result or comparison | no | ready |

`disabled` has no client, `shadow` keeps local output authoritative, and `rust` applies only the table's one fallback. Existing public health remains unchanged.

## Raw corpus and parser deletion accounting

`manifest.json` is the source of truth: each raw byte file has a SHA-256, source kind, exact expected fixture/error, and one planned Node plus Rust consumer. The raw yt-dlp fixtures preserve the useful resolve security behavior (valid output; forbidden `Host`; forbidden manifest protocol; schema-malformed output; syntactically malformed JSON). The Innertube fixture preserves raw-ordinal scoring. Files are synthetic and contain no credentials or signed URLs.

The following pre-delete `parseSearchOutput` cases in `apps/server/tests/media/youtube.test.ts:211-366` are implementation-only and have no sidecar-equivalent raw bytes. They are retained in the manifest because Task 4 may delete them only after this accounting:

| Original test | Rationale |
| --- | --- |
| parses a search fixture into shared tracks | Obsolete yt-dlp flat-search normalization is replaced by Innertube search. |
| Given selected audio formats When search metadata is parsed Then higher bitrates rank first | Obsolete yt-dlp abr ranking is replaced by fixed raw-ordinal scoring. |
| rejects malformed external JSON | Obsolete parser shape rejection is replaced by strict sidecar protocol validation. |
| derives YouTube artwork when flat search omits a thumbnail | Obsolete yt-dlp thumbnail fallback is replaced by required Innertube renderer artwork. |
| ranks a verified official artist upload above an unofficial copy | Obsolete heuristic ranking is replaced by raw ordinal ordering. |
| collapses duplicate audio video and lyric uploads of the same song | Obsolete heuristic deduplication is replaced by bounded renderer extraction. |
| keeps meaningful alternate versions as separate choices | Obsolete yt-dlp alternate-version heuristic is replaced by raw renderer results. |

Run `node spec/media-sidecar/v1/contract.test.mjs --verify-manifest --verify-parser-migration --verify-ordinals` for hashes, migration accounting, strict fixtures, and ordinal semantics. Run `node spec/media-sidecar/v1/contract.test.mjs --negative` for the mismatch, schema-drift, 16 KiB, content-type, unsafe-header, and unsafe-response corpus.
