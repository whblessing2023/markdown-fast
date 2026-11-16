# markdown-fast

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/whblessing2023/markdown-fast/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/whblessing2023/markdown-fast/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A from-scratch Markdown renderer that returns exactly what [marked](https://github.com/markedjs/marked) 18.1.3 returns, faster. Built for the make.fun bounty [“Make Markdown rendering faster”](https://make.fun/c/markdown-render-speed-02) ($250 in USDC on Solana).

`parse(markdown)` matches `marked.parse(markdown)` with marked's default options (GFM on, breaks off, pedantic off, synchronous) byte for byte on every input — including the places where marked itself departs from the CommonMark and GFM specs. Nothing is copied from marked's source; the behaviour was re-derived from its rules and verified against its output.

## Score

Practice set — 680 CommonMark 0.31.2 / GFM 0.29 spec examples plus 40 generated documents, 720 cases in all, graded by the competition's own scorer:

- **720 / 720 cases byte-identical** to marked 18.1.3 (`passed: 1`).
- **About 1.6× faster than marked** on CPU time over the same set (roughly 0.44 s vs 0.70 s per full pass, Node 24, local run, median of five rounds; repeated runs land between 1.54× and 1.66×).
- Differential fuzzing against marked: 0 mismatches across 80,000 randomly generated short documents and 500 long documents (30–150 blocks each), plus targeted cases for nested lists, blockquotes, and setext edges.
- Deterministic: two runs over the practice set produce byte-identical output.

## Layout

- `parse.js` — the whole renderer. A dependency-free ES module; its only export is `parse(markdown)`.
- `main.ts` — the driver the harness runs as `node /bot/main.ts` (Node 22, types stripped natively). It reads `/input/cases.json`, renders each case on its own, and writes the HTML strings in order to `/output/html.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.
- `LICENSE` — MIT.

## Design

- **One cursor, sticky patterns.** Block lexing walks the input with a single position and `y`-flagged regular expressions, never re-slicing the remaining input after each token the way marked does. Each block rule is only attempted when the next character can start it.
- **First-character dispatch.** The inline loop dispatches on the character at the cursor, so most positions try exactly one rule instead of eleven. The order inside each character group is marked's own: an email address may start on `_`, `.`, `+` or `-` as well as on an alphanumeric character, so those characters attempt the URL rule too.
- **A lean text rule.** The text rule's protocol/email lookaheads are skipped whenever the string cannot contain a URL or email trigger (`://`, `www.`, `@`, `mailto:`, `xmpp:`); the gate is exact, so the lean rule agrees with the full rule wherever it is used.
- **Cheap list lexing.** The list line loop counts indentation with `charCodeAt`, expands tabs only when one is present, and dispatches the six break tests on the first non-space character. The setext check stays after the break conditions, exactly as in marked.
- **Gated emphasis masking.** Each of the three masking passes runs only when its trigger character is present, and delimiter runs are measured without spreading strings into code-point arrays (delimiter runs are pure ASCII, so code-point count equals length; surrogate-aware `charCodeAt` handles the edges).
- **Block-lexer guards.** The setext-heading and table rules are skipped unless the source (or the next line) can possibly contain one, and the `\r\n` normalisation is skipped when the input has no carriage return. Guards are per-`parse()` state, never shared across cases.
- **Block nodes, inline text deferred.** Block lexing builds a small tree of nodes and collects every link reference definition first; inline sources are rendered afterwards, so a reference defined later in the document resolves exactly as in marked.
- **Direct rendering.** There is no intermediate inline token list: the inline loop writes HTML straight out, and an image's alt text is produced by the same loop running in plain-text mode.
- **Emphasis the way marked does it.** The delimiter-run search, the rule of three, and the left/right-flanking tests follow marked's own tokenizer, including its quirks — a `_` run flanked by word characters on both sides never closes, a `*` run after a space does open, and the paragraph-merge flag inside blockquotes is spent after the first paragraph of each inner pass.
- **Marked's shared lexer state, faithfully.** Two of marked's subtler behaviours are reproduced, not just its rules: lexing a nested list leaves `state.top` true, so text after a nested list inside a list item becomes a paragraph; and when a blockquote re-lexes a nested blockquote or list, the discarded first pass's inline tokenization still runs, so an unclosed `<a>` tag in it leaves `inLink` set for the real pass. The replacement node carries the orphaned sources and the renderer replays them (output discarded) at exactly that point.
- **No state between calls.** `parse` keeps nothing from an earlier call, reads no clock, touches no network, and uses no native code or WebAssembly. The whole repository is under 70 KB.

## Try it

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

```sh
MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=path/to/output node main.ts
```

## Where it follows marked over the spec

A few examples, all confirmed against marked 18.1.3:

- An ordered list interrupts a paragraph only when it starts with `1`; `14.` after a paragraph line stays paragraph text.
- A table-shaped pair of lines ends a paragraph even when the column counts do not match and no table is ever built.
- A fenced code block with an empty body renders `<pre><code></code></pre>` with no newline inside.
- Image alt text is the label rendered as plain text: nested links and images collapse to their text, and an inner emphasis run disappears.
- The `punctuation` test used for emphasis flanking counts whitespace as well as punctuation.
- Text after a nested list inside a list item becomes a paragraph (`- *\nb` renders `<p>b</p>` inside the item, not bare text), because marked's `blockTokens` returns with `state.top` set.
- A bare URL after an unclosed `<a>` tag inside a re-lexed nested blockquote is not linkified, because the discarded first pass leaves `inLink` set.

## License

MIT. See [LICENSE](LICENSE).
