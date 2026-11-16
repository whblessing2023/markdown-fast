# markdown-fast

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/whblessing2023/markdown-fast/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/whblessing2023/markdown-fast/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A from-scratch Markdown renderer that returns exactly what [marked](https://github.com/markedjs/marked) 18.1.3 returns, faster. Built for the make.fun bounty [“Make Markdown rendering faster”](https://make.fun/c/markdown-render-speed-02) ($250 in USDC on Solana).

`parse(markdown)` matches `marked.parse(markdown)` with marked's default options (GFM on, breaks off, pedantic off, synchronous) byte for byte on every input — including the places where marked itself departs from the CommonMark and GFM specs. Nothing is copied from marked's source; the behaviour was re-derived from its rules and verified against its output.

## Score

Practice set — 680 CommonMark 0.31.2 / GFM 0.29 spec examples plus 40 generated documents, 720 cases in all, graded by the competition's own scorer:

- **720 / 720 cases byte-identical** to marked 18.1.3 (`passed: 1`).
- **About 1.25× faster than marked** on CPU time over the same set (roughly 0.57 s vs 0.73 s per full pass, Node 24, local run, five rounds).
- Differential fuzzing against marked: 0 mismatches across ~47,000 randomly generated documents.
- Deterministic: two runs over the practice set produce byte-identical output.

## Layout

- `parse.js` — the whole renderer. A dependency-free ES module; its only export is `parse(markdown)`.
- `main.ts` — the driver the harness runs as `node /bot/main.ts` (Node 22, types stripped natively). It reads `/input/cases.json`, renders each case on its own, and writes the HTML strings in order to `/output/html.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.
- `LICENSE` — MIT.

## Design

- **One cursor, sticky patterns.** Block lexing walks the input with a single position and `y`-flagged regular expressions, never re-slicing the remaining input after each token the way marked does. Each block rule is only attempted when the next character can start it.
- **Block nodes, inline text deferred.** Block lexing builds a small tree of nodes and collects every link reference definition first; inline sources are rendered afterwards, so a reference defined later in the document resolves exactly as in marked.
- **Direct rendering.** There is no intermediate inline token list: the inline loop writes HTML straight out, and an image's alt text is produced by the same loop running in plain-text mode.
- **Emphasis the way marked does it.** The delimiter-run search, the rule of three, and the left/right-flanking tests follow marked's own tokenizer, including its quirks — a `_` run flanked by word characters on both sides never closes, a `*` run after a space does open, and the paragraph-merge flag inside blockquotes is spent after the first paragraph of each inner pass.
- **No state between calls.** `parse` keeps nothing from an earlier call, reads no clock, touches no network, and uses no native code or WebAssembly. The whole repository is under 60 KB.

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

## License

MIT. See [LICENSE](LICENSE).
