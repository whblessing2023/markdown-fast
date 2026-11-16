// markdown-fast — parse.js
//
// A fast, dependency-free Markdown renderer whose parse(markdown) returns
// exactly the HTML that marked 18.1.3 renders with its default options
// (gfm on, breaks off, pedantic off, async off), byte for byte — including
// every place where marked departs from the CommonMark or GFM spec.
//
// Written from scratch for the make.fun "Make Markdown rendering faster"
// bounty. The block and inline grammars follow marked's rules, because the
// output must match marked code unit for code unit; the implementation
// around them is my own: a single cursor over the source with sticky
// regular expressions (no re-slicing per token), no token tree, and inline
// content rendered straight to HTML once the whole document's link
// reference definitions are known.
//
// Optimisations in this revision, all verified against marked on the
// practice set and on differential fuzzing:
//  - the inline loop dispatches on the first character, so most positions
//    try exactly one rule instead of eleven;
//  - the text rule has a lean variant used when the string cannot contain
//    a URL or email trigger, so the protocol/email lookaheads are skipped;
//  - the list line loop counts indentation with charCodeAt, expands tabs
//    only when one is present, and dispatches the six break tests on the
//    first non-space character;
//  - emphasis masking runs each of its three passes only when its trigger
//    character is present, and delimiter runs are measured without
//    spreading strings into code-point arrays;
//  - the block lexer skips the setext-heading and table rules unless the
//    source (or the next line) can possibly contain one; the setext guard
//    itself is a manual line scan, not a /m regex test, which measures
//    ~3% faster on the practice set.
//
// No caching across cases: parse() keeps nothing from an earlier call.
// No network, no clock, no environment reads, no WebAssembly.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape &, <, >, " and '. With encode=false, an & that already starts a
// character reference or entity is left alone (marked's escapeTestNoEncode).
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_NOENC_REPLACE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function esc(s, encode = false) {
  if (encode) {
    return ESC_TEST.test(s) ? s.replace(ESC_REPLACE, (c) => ESCAPES[c]) : s;
  }
  return ESC_NOENC_TEST.test(s) ? s.replace(ESC_NOENC_REPLACE, (c) => ESCAPES[c] ?? '&amp;') : s;
}

// Decode numeric character references and &amp; (marked's unescape).
const NUM_REF = /&(?:#(\d{1,7})|#[Xx]([0-9A-Fa-f]{1,6}));/;
const NUM_REF_OR_AMP = /&(?:#(\d{1,7})|#[Xx]([0-9A-Fa-f]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function unesc(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Percent-encode a URL the way marked does; null when it cannot be encoded.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// A link label's lookup key: trim, collapse whitespace to one space, then
// lower/upper/lower case folding (marked's normalize).
const WS_RUN = /\s+/g;
function labelKey(label) {
  return label.trim().replace(WS_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove a character from the end of a string, repeatedly (marked's rtrim).
function trimEndChar(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Drop trailing blank lines, but keep the text when there are at most two
// lines after the last non-blank one (marked's trimBlankLines).
const BLANK_LINE = /^[ \t]*$/;
function stripBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, counting columns from `col` (marked's expandTabs).
function expandTabs(s, col = 0) {
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Find the index of the closing paren matching an opener at `open`, or -1
// when balanced, -2 when an opener is left unclosed (marked's findClosingBracket).
function parenBalance(s, open = '(', close = ')') {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes, honouring the expected column count.
const PIPE = /\|/g;
function splitRow(line, count) {
  const cells = line
    .replace(PIPE, (m, off, str) => {
      let escaped = false;
      for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
      return escaped ? '|' : ' |';
    })
    .split(' |');
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Count the leading run of spaces and tabs in `s` starting at `from`:
// returns [length, hasTab]. Used wherever marked counts indentation.
function leadWs(s, from = 0) {
  let k = from;
  let hasTab = false;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32) k++;
    else if (c === 9) {
      hasTab = true;
      k++;
    } else break;
  }
  return [k - from, hasTab];
}

// Expand only the leading whitespace of `line` (tabs to spaces, counted
// from `col`); when the leading run has no tab this is the identity, so
// the common no-tab case costs one short scan and no allocation.
function expandLead(line, col = 0) {
  const [n, hasTab] = leadWs(line);
  if (!hasTab) return line;
  return expandTabs(line.slice(0, n), col) + line.slice(n);
}

// Index of the first character of `s` that is not a space (charCode 32),
// or s.length. Tabs count as non-space here, exactly like /[^ ]/.
function firstNonSpace(s, from = 0) {
  let k = from;
  while (k < s.length && s.charCodeAt(k) === 32) k++;
  return k;
}

// ---------------------------------------------------------------------------
// Grammar
//
// The patterns below follow marked's block and inline rules: the output
// must match marked code unit for code unit, so the grammars are the same.
// `subPat` composes a pattern from placeholders the way marked's own
// builder does: a placeholder is replaced by the source of another pattern
// (its leading ^ dropped, since it would only ever match at position 0),
// first occurrence for a string key, every occurrence for a /g key.

// Turn every capturing group in a replacement source into a non-capturing
// one, so substituting it into another pattern never shifts that
// pattern's group numbers. (marked does the same by writing its
// substituted variants non-capturing.) Escaped parens and parens inside
// character classes are left alone; (?...) constructs are already
// non-capturing.
function nonCap(src) {
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      out += src.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    if (c === ']') inClass = false;
    if (c === '(' && !inClass && src[i + 1] !== '?') {
      out += '(?:';
      continue;
    }
    out += c;
  }
  return out;
}

function subPat(pattern, subs, flags = '') {
  let s = typeof pattern === 'string' ? pattern : pattern.source;
  for (const key of Object.keys(subs)) {
    let rep = subs[key];
    rep = typeof rep === 'string' ? rep : rep.source;
    rep = rep.replace(/(^|[^[])\^/g, '$1');
    rep = nonCap(rep);
    // A key written /name/g is a global placeholder; anything else is a
    // plain string replaced at its first occurrence.
    let pat = key;
    const g = /^\/(.*)\/([a-z]*)$/.exec(key);
    if (g) pat = new RegExp(g[1], g[2]);
    s = s.replace(pat, () => rep);
  }
  return new RegExp(s, flags);
}

// A sticky copy of a ^-anchored pattern: it matches at lastIndex instead of
// at the start of a sliced string, so the lexer can keep one cursor over
// the whole source and never re-slice it. Every ^ that starts the pattern
// or an alternative is dropped (a ^ after ( is left alone); a ^ inside a
// character class is never an anchor.
function sticky(re) {
  const src = re.source;
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      out += src.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    if (c === ']') inClass = false;
    if (c === '^' && !inClass && (i === 0 || src[i - 1] === '|')) continue;
    out += c;
  }
  return new RegExp(out, re.flags.includes('y') ? re.flags : re.flags + 'y');
}

// Run a sticky pattern at `pos` in `s`; null when it does not match there.
function at(re, s, pos) {
  re.lastIndex = pos;
  return re.exec(s);
}

const TAG_LIST =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const ATTR_RE = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const INLINE_ATTR_RE = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const TILDE_NOT_PUNCT_SPACE = /(?:[^\s\p{P}\p{S}]|~)/u;
const TILDE_PUNCT_SPACE = /(?!~)[\s\p{P}\p{S}]/u;
const TILDE_PUNCT = /(?!~)[\p{P}\p{S}]/u;

// --- block grammar (gfm) ---
const B_SPACE = /^(?:[ \t]*(?:\n|$))+/;
const B_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const B_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const B_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const B_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const B_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const B_LIST = subPat(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, { bull: B_BULLET });
const B_HTML = subPat(
  /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|comment[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(tag)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/,
  { comment: COMMENT_RE, tag: TAG_LIST, attribute: ATTR_RE },
  'i'
);
const LABEL_INNER = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_HEAD = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_RE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const B_DEF = subPat(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  { label: LABEL_HEAD, title: TITLE_RE }
);
const B_TABLE = subPat(
  /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)/,
  {
    hr: B_HR,
    heading: / {0,3}#{1,6}(?:\s|$)/,
    blockquote: / {0,3}>/,
    code: /(?: {4}| {0,3}\t)[^\n]/,
    fences: / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
    list: / {0,3}(?:[*+-]|1[.)])[ \t]/,
    html: / {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/,
    tag: TAG_LIST,
  }
);
const LHEADING_SRC =
  /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const B_LHEADING = subPat(LHEADING_SRC, {
  [/bull/g]: B_BULLET,
  blockCode: /(?: {4}| {0,3}\t)/,
  [/fences/g]: / {0,3}(?:`{3,}|~{3,})/,
  [/blockquote/g]: / {0,3}>/,
  [/heading/g]: / {0,3}#{1,6}(?:\s|$)/,
  [/hr/g]: B_HR,
  [/html/g]: / {0,3}<[^\n>]+>\n/,
  [/table/g]: / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/,
});
const PARA_SRC = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const B_PARAGRAPH = subPat(PARA_SRC, {
  hr: B_HR,
  heading: / {0,3}#{1,6}(?:\s|$)/,
  '|lheading': '',
  table: B_TABLE,
  blockquote: / {0,3}>/,
  fences: / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
  list: / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/,
  html: / {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/,
  tag: TAG_LIST,
});
// The paragraph shape used inside blockquotes (no table, no lheading, and a
// list item stops it on a bare bullet as well as on a filled one).
const B_QUOTE_PARA = subPat(PARA_SRC, {
  hr: B_HR,
  heading: / {0,3}#{1,6}(?:\s|$)/,
  '|lheading': '',
  '|table': '',
  blockquote: / {0,3}>/,
  fences: / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
  list: / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/,
  html: / {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/,
  tag: TAG_LIST,
});
const B_BLOCKQUOTE = subPat(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  { paragraph: B_QUOTE_PARA }
);
const B_TEXT = /^[^\n]+/;

// A line that could be a setext underline (used as a cheap guard: when no
// such line exists in the source being lexed, the setext rule can never
// match and is skipped outright). A manual scan, not the equivalent
// /^ {0,3}(?:=+|-+)[ \t]*$/m regex: it jumps line to line with indexOf
// instead of running the regex engine over the whole source, and measures
// ~3% faster on the practice set. Equivalent on the real input domain
// (line endings are normalised to \n before lexing, where $ also matches
// before \r — the regex and this scan agree on every \n-only string).
function hasSetextLine(src) {
  const end = src.length;
  let i = 0;
  while (i < end) {
    let j = i;
    let sp = 0;
    while (j < end && src.charCodeAt(j) === 32 && sp < 3) { j++; sp++; }
    const c = j < end ? src.charCodeAt(j) : -1;
    if (c === 61 || c === 45) {
      let k = j + 1;
      while (k < end && src.charCodeAt(k) === c) k++;
      while (k < end && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
      if (k === end || src.charCodeAt(k) === 10) return true;
    }
    const nl = src.indexOf('\n', i);
    if (nl === -1) break;
    i = nl + 1;
  }
  return false;
}

// Indent-dependent patterns (marked's memoised builders), precomputed for
// indents 0..3; the list code clamps the indent the same way.
function listItemRe(bullet) {
  return new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`);
}
const NEXT_BULLET_RE = [0, 1, 2, 3].map(
  (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)
);
const HR_INDENT_RE = [0, 1, 2, 3].map(
  (n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)
);
const FENCES_BEGIN_RE = [0, 1, 2, 3].map((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const HEADING_BEGIN_RE = [0, 1, 2, 3].map((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const HTML_BEGIN_RE = [0, 1, 2, 3].map(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i'
    )
);
const BLOCKQUOTE_BEGIN_RE = [0, 1, 2, 3].map((n) => new RegExp(`^ {0,${n}}>`));
const clampIndent = (n) => Math.max(0, Math.min(3, n - 1));

// --- inline grammar (gfm) ---
const I_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const I_TAG = subPat(
  /^comment|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  {
    comment: /<!--(?:-?>|[\s\S]*?-->)/,
    attribute: INLINE_ATTR_RE,
  }
);
const BRACKET_INNER = subPat(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  { brackets: /\[(?:\\[\s\S]|[^\[\]\\])*\]/ }
);
const I_LINK = subPat(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  {
    label: BRACKET_INNER,
    href: /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/,
    title: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
  }
);
const I_REFLINK = subPat(/^!?\[(label)\]\[(ref)\]/, { label: BRACKET_INNER, ref: LABEL_INNER });
const I_NOLINK = subPat(/^!?\[(ref)\](?:\[\])?/, { ref: LABEL_INNER });
// The looser label shapes the emphasis mask searches with.
const LABEL_LOOSE = subPat(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  { brackets: /\[(?:\\[\s\S]|[^\[\]\\])*\]/ }
);
const REF_LOOSE = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const I_REFLINK_SEARCH = subPat(/reflink|nolink(?!\()/, {
  reflink: subPat(/^!?\[(label)\]\[(ref)\]/, { label: LABEL_LOOSE, ref: REF_LOOSE }),
  nolink: subPat(/^!?\[(ref)\](?:\[\])?/, { ref: REF_LOOSE }),
}, 'g');
const LDELIM_SRC = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const I_LDELIM = subPat(LDELIM_SRC, { [/punct/g]: TILDE_PUNCT }, 'u');
const RDELIM_AST_SRC =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const I_RDELIM_AST = subPat(RDELIM_AST_SRC, {
  [/notPunctSpace/g]: TILDE_NOT_PUNCT_SPACE,
  [/punctSpace/g]: TILDE_PUNCT_SPACE,
  [/punct/g]: TILDE_PUNCT,
}, 'gu');
const RDELIM_UND_SRC =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const I_RDELIM_UND = subPat(RDELIM_UND_SRC, {
  [/notPunctSpace/g]: NOT_PUNCT_SPACE,
  [/punctSpace/g]: PUNCT_SPACE,
  [/punct/g]: PUNCT,
}, 'gu');
const I_DEL_LDELIM = subPat(/^~~?(?:((?!~)punct)|[^\s~])/, { punct: PUNCT }, 'u');
const DEL_RDELIM_SRC =
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const I_DEL_RDELIM = subPat(DEL_RDELIM_SRC, {
  [/notPunctSpace/g]: NOT_PUNCT_SPACE,
  [/punctSpace/g]: PUNCT_SPACE,
  [/punct/g]: PUNCT,
}, 'gu');
const I_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const I_CODESPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const I_AUTOLINK = subPat(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, {
  scheme: /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/,
  email: /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(?<at>@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
});
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO = subPat(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, { [/email/g]: EMAIL_RE });
const I_URL = subPat(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, {
  emailProtocol: EMAIL_PROTO,
  protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
  email: /[A-Za-z0-9._+-]+(?<at>@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
});
const I_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const I_TEXT = subPat(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_])|(?=\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  {
    protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
    [/emailProtocol/g]: /(?:mailto|xmpp):/,
    wwwStart: /(?<![^\s*_~(])www\./,
  }
);
// The text rule with every URL/email lookahead removed. It is exactly the
// full rule on any string that cannot contain a URL or email trigger, so
// the inline loop uses it whenever the gate below says so.
const I_TEXT_LEAN =
  /^(?:(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*~_])|(?=\b_|$)|[^ ](?= {2,}\n))))/;
// True when the string can contain something the lean rule cannot see:
// a protocol (://), a www. link, an email (@), or a mailto:/xmpp: address.
const URL_TRIGGER = /:\/\/|www\.|@|mailto:|xmpp:/;
const I_BLOCKSKIP = subPat(/link|precode-code|html/, {
  link: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  'precode-': /(?<!`)()/,
  code: /(?<b>`+)[^`]+\k<b>(?!`)/,
  html: /<(?! )[^<>]*?>/,
}, 'g');
const I_ANYPUNCT = /\\([\p{P}\p{S}])/gu;
const I_ANYPUNCT_OUTSIDE_CODE = subPat(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, { punct: PUNCT }, 'gu');

// Sticky copies used by the cursor lexers.
const S = {
  space: sticky(B_SPACE),
  code: sticky(B_CODE),
  fences: sticky(B_FENCES),
  heading: sticky(B_HEADING),
  hr: sticky(B_HR),
  list: sticky(B_LIST),
  html: sticky(B_HTML),
  def: sticky(B_DEF),
  table: sticky(B_TABLE),
  lheading: sticky(B_LHEADING),
  paragraph: sticky(B_PARAGRAPH),
  blockquote: sticky(B_BLOCKQUOTE),
  text: sticky(B_TEXT),
  escape: sticky(I_ESCAPE),
  tag: sticky(I_TAG),
  link: sticky(I_LINK),
  reflink: sticky(I_REFLINK),
  nolink: sticky(I_NOLINK),
  ldelim: sticky(I_LDELIM),
  delLdelim: sticky(I_DEL_LDELIM),
  del: sticky(I_DEL),
  codespan: sticky(I_CODESPAN),
  br: sticky(I_BR),
  autolink: sticky(I_AUTOLINK),
  url: sticky(I_URL),
  inlineText: sticky(I_TEXT),
  inlineTextLean: sticky(I_TEXT_LEAN),
};
const S_NEXT_BULLET = NEXT_BULLET_RE.map((r) => sticky(r));
const S_HR_INDENT = HR_INDENT_RE.map((r) => sticky(r));
const S_FENCES_BEGIN = FENCES_BEGIN_RE.map((r) => sticky(r));
const S_HEADING_BEGIN = HEADING_BEGIN_RE.map((r) => sticky(r));
const S_HTML_BEGIN = HTML_BEGIN_RE.map((r) => sticky(r));
const S_BLOCKQUOTE_BEGIN = BLOCKQUOTE_BEGIN_RE.map((r) => sticky(r));

// ---------------------------------------------------------------------------
// Emphasis masking
//
// Before the inline loop searches for emphasis closers, marked masks the
// source: link labels, code spans and raw HTML are replaced by runs of
// 'a'/' '+', so a delimiter inside them can never be mistaken for a
// closer, and the last index where a *, _ or ~ run starts after a
// non-space character is recorded. The mask is computed once per inline
// string, lazily, on the first emphasis attempt.
//
// Each of the three masking passes runs only when its trigger character
// is present: the reference pass needs '[', the punctuation pass needs
// '`' or a backslash (it masks code-span backticks and backslash-escaped
// punctuation — the escape part is load-bearing, so a lone backslash
// still runs it), and the block-skip pass needs '[', '`' or '<'. When
// none of them can match, the pass is the identity, so skipping it
// changes nothing.

// Does `s` contain a link (a [...]() link, or a reference whose label is
// known)? Used while masking, to decide whether a [...] label is real.
function linkInText(s, links) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(I_BLOCKSKIP)) {
    if (I_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(I_REFLINK_SEARCH)) {
    const whole = m[0];
    const o = whole.lastIndexOf('[');
    if (
      whole.charAt(0) !== '!' &&
      Object.hasOwn(links, labelKey(whole.slice(o + 1, -1))) &&
      !(o > 1 && linkInText(whole.slice(1, o - 1), links))
    ) {
      return true;
    }
  }
  return false;
}

// The masked source: reference links become [aaa], code spans and raw HTML
// become [aaa] too, and backslash-escaped punctuation becomes '+'.
function maskEmStrong(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskRef = (whole) => {
      const o = whole.lastIndexOf('[');
      if (!Object.hasOwn(links, labelKey(whole.slice(o + 1, -1)))) return whole;
      if (o > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(I_REFLINK_SEARCH, maskRef) + '][' + 'a'.repeat(whole.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    t = t.replace(I_REFLINK_SEARCH, maskRef);
  }
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(I_ANYPUNCT_OUTSIDE_CODE, (whole, ticks, punct) =>
      punct
        ? '+'.repeat(whole.length)
        : ticks
          ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
          : whole
    );
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(I_BLOCKSKIP, (whole) => '[' + 'a'.repeat(whole.length - 2) + ']');
  }
  return t;
}

// Last index where a delimiter run starts after a non-space character.
function scanDelims(masked) {
  const star = { '*': -1, '_': -1 };
  let tilde = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else star[ch] = i;
    }
    i = j - 1;
  }
  return { star, tilde };
}

// One inline string's mask, computed on first use and reused.
function makeMask(src, links) {
  let m = null;
  return () => {
    if (!m) {
      const masked =
        src.includes('*') || src.includes('_') || src.includes('~') ? maskEmStrong(src, links) : src;
      const d = scanDelims(masked);
      m = { masked, star: d.star, tilde: d.tilde };
    }
    return m;
  };
}

// Is there a tag or autolink starting inside a link label, reaching past
// the label's end? Then the link is not a link (marked's linkInText check
// for labels, here named hasTagInLabel).
function hasTagInLabel(src, label, start) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const code = I_CODESPAN.exec(label.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(start + s);
    const tag = I_TAG.exec(rest) || I_AUTOLINK.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// The last code point of `s` ending at index `end` (exclusive), as a
// string. Delimiter-adjacent characters are usually BMP, but an astral
// character before a delimiter must come back whole, not split.
function lastCodePoint(s, end) {
  if (end <= 0) return '';
  const lo = s.charCodeAt(end - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
    const hi = s.charCodeAt(end - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(end - 2, end);
  }
  return s[end - 1];
}

// Length in code units of the first code point of `s`: 2 for an astral
// character, 1 otherwise (including a lone surrogate).
function firstCodePointLen(s) {
  if (s.length === 0) return 0;
  const hi = s.charCodeAt(0);
  if (hi >= 0xd800 && hi <= 0xdbff && s.length > 1) {
    const lo = s.charCodeAt(1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
  }
  return 1;
}

// Length of the leading run of `delim` code units at the start of `s`.
// Delimiter runs are pure ASCII, so the run length in code units is the
// run length in code points.
function delimRunLen(s, delimCode) {
  let n = 0;
  while (n < s.length && s.charCodeAt(n) === delimCode) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Inline rendering
//
// inlineHtml renders one inline source straight to HTML. `st` is the
// shared lexer state (inLink, inRawBlock, linkEmitted, linkParenPossible);
// it is mutated exactly the way marked's lexer mutates its own, so a
// link inside a link, or a <pre> opened inside a paragraph, behaves the
// same. inlinePlain is the same loop with the text renderer: emphasis,
// links and images render as their plain text, code spans as their text,
// hard breaks as nothing — the alt text of an image, and the text of a
// link whose URL will not encode.

function inlineHtml(src, links, st) {
  const saved = st.linkParenPossible;
  st.linkParenPossible = saved && src.includes(')');
  try {
    return inlineLoop(src, links, st, false);
  } finally {
    st.linkParenPossible = saved;
  }
}

function inlinePlain(src, links, st) {
  const saved = st.linkParenPossible;
  st.linkParenPossible = saved && src.includes(')');
  try {
    return inlineLoop(src, links, st, true);
  } finally {
    st.linkParenPossible = saved;
  }
}

// Build an <a> or <img> from a matched link/reflink. Returns
// { html, len } or null when the link is dropped (an inner link was found,
// or the URL will not encode for an image). `label` is the link text with
// its bracket escapes undone; `href`/`title` are already processed.
function outputLink(label, href, title, isImage, rawLen, links, st, plain) {
  const prevInLink = st.inLink;
  const prevEmitted = st.linkEmitted;
  const prevRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  // An image's label is always rendered as plain text for its alt
  // attribute; a link's label follows the surrounding renderer.
  const inner = isImage || plain ? inlinePlain(label, links, st) : inlineHtml(label, links, st);
  const innerEmitted = st.linkEmitted;
  st.linkEmitted = prevEmitted;
  st.inLink = prevInLink;
  if (!isImage) {
    if (innerEmitted) {
      st.inRawBlock = prevRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  const url = cleanUrl(href);
  if (isImage) {
    if (plain) return { html: inner, len: rawLen };
    if (url === null) return { html: esc(inner), len: rawLen };
    let o = `<img src="${esc(url)}" alt="${esc(inner)}"`;
    if (title) o += ` title="${esc(title)}"`;
    return { html: o + '>', len: rawLen };
  }
  if (url === null || plain) return { html: inner, len: rawLen };
  let o = `<a href="${esc(url)}"`;
  if (title) o += ` title="${esc(title)}"`;
  return { html: o + '>' + inner + '</a>', len: rawLen };
}

// Try an inline link [label](href "title") at `pos`. Returns
// { html, len } or null.
function tryLink(src, pos, links, st, plain) {
  if (!st.linkParenPossible) return null;
  const m = at(S.link, src, pos);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  if (hasTagInLabel(src, m[1], pos + (isImage ? 2 : 1))) return null;
  let raw = m[0];
  let hrefPart = m[2];
  let titlePart = m[3];
  const s = hrefPart.trim();
  if (/^</.test(s)) {
    if (!/>$/.test(s)) return null;
    const cut = trimEndChar(s.slice(0, -1), '\\');
    if ((s.length - cut.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(hrefPart, '(', ')');
    if (bal === -2) return null;
    if (bal > -1) {
      const h = (isImage ? 5 : 4) + m[1].length + bal;
      hrefPart = hrefPart.substring(0, bal);
      raw = raw.substring(0, h).trim();
      titlePart = '';
    }
  }
  const cut2 = trimEndChar(raw.slice(0, -1), '\\');
  if ((raw.length - cut2.length) % 2 === 0) return null;
  let href = hrefPart.trim();
  const title = titlePart ? titlePart.slice(1, -1) : '';
  if (/^</.test(href)) href = href.slice(1, -1);
  href = href ? href.replace(I_ANYPUNCT, '$1') : href;
  const cleanTitle = title ? title.replace(I_ANYPUNCT, '$1') : title;
  const label = m[1].replace(/\\([\[\]])/g, '$1');
  return outputLink(label, href, cleanTitle, isImage, raw.length, links, st, plain);
}

// Try a reference link [label][ref] or [label] at `pos`. Returns
// { html, len } for a link, { html, len: 1 } for the one-character text
// fallback when the label is unknown, or null when nothing matches.
function tryRefLink(src, pos, links, st, plain) {
  const m = at(S.reflink, src, pos) || at(S.nolink, src, pos);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  if (hasTagInLabel(src, m[1], pos + (isImage ? 2 : 1))) return null;
  const ref = links[labelKey(m[2] || m[1])];
  if (!ref) return { html: m[0].charAt(0), len: 1, text: true };
  const label = m[1].replace(/\\([\[\]])/g, '$1');
  return outputLink(label, ref.href, ref.title || '', isImage, m[0].length, links, st, plain);
}

// Try emphasis/strong at `pos`. `prevChar` is the character before this
// position ('' when the previous token was not text). Returns
// { html, len } or null. `getMask` lazily gives the whole inline source
// with emphasis masked plus the last possible closer indexes.
// marked's "punctuation" test for delimiter flanking: a whitespace or
// punctuation character that is not * or _.
const I_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;

function tryEmStrong(src, pos, getMask, prevChar, links, st, plain) {
  const s = at(S.ldelim, src, pos);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const mask = getMask();
  const masked = mask.masked;
  const delim = s[0][0];
  const openedNextToDelim = prevChar === delim;
  let i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = lastCodePoint(masked, l);
  const h = p === '*' || p === '_' || I_PUNCT.test(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : I_PUNCT.test(n);
  if (s[4] && /[\p{L}\p{N}]/u.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    // k is the opener length in code points minus one: the leading
    // delimiter run (pure ASCII) plus one when a following character
    // was consumed, minus one.
    const run = delimRunLen(s[0], delim.charCodeAt(0));
    const k = run - 1 + (s[0].length > run ? 1 : 0);
    let mLen = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (delim === '*' && !h));
    const A = delim === '*' ? I_RDELIM_AST : I_RDELIM_UND;
    const v = mask.star[delim];
    const Q = pos + k;
    if (v < Q) return null;
    const t = masked.slice(Q);
    const bound = v - Q;
    let g;
    let b;
    let s2;
    for (A.lastIndex = 0; (s2 = A.exec(t)) !== null && !(s2.index > bound); ) {
      g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      b = g.length;
      if (s2[3] || s2[4]) {
        mLen += b;
        continue;
      } else if (s2[5] || s2[6] || R) {
        if (openedNextToDelim && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      mLen -= b;
      if (mLen > 0) continue;
      b = Math.min(b, b + mLen + f);
      const te = firstCodePointLen(s2[0]);
      const raw = src.slice(pos, pos + k + s2.index + te + b);
      if (Math.min(k, b) % 2) {
        const innerText = raw.slice(1, -1);
        const inner = plain ? inlinePlain(innerText, links, st) : inlineHtml(innerText, links, st);
        return { html: plain ? inner : `<em>${inner}</em>`, len: raw.length };
      }
      const innerText = raw.slice(2, -2);
      const inner = plain ? inlinePlain(innerText, links, st) : inlineHtml(innerText, links, st);
      return { html: plain ? inner : `<strong>${inner}</strong>`, len: raw.length };
    }
  }
  return null;
}

// Try strikethrough at `pos`. Returns { html, len } or null.
function tryDel(src, pos, getMask, prevChar, links, st, plain) {
  const s = at(S.delLdelim, src, pos);
  if (!s) return null;
  if (!(s[1] || '') || !prevChar || I_PUNCT.test(prevChar)) {
    const mask = getMask();
    const masked = mask.masked;
    const run = delimRunLen(s[0], 126);
    const o = run - 1 + (s[0].length > run ? 1 : 0);
    let p = o;
    const u = mask.tilde;
    const d = pos + o;
    if (u < d) return null;
    const t = masked.slice(d);
    const bound = u - d;
    let i2;
    let l2;
    let s2;
    for (I_DEL_RDELIM.lastIndex = 0; (s2 = I_DEL_RDELIM.exec(t)) !== null && !(s2.index > bound); ) {
      i2 = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!i2) continue;
      l2 = i2.length;
      if (l2 !== o) continue;
      if (s2[3] || s2[4]) {
        p += l2;
        continue;
      }
      p -= l2;
      if (p > 0) continue;
      l2 = Math.min(l2, l2 + p);
      const g = firstCodePointLen(s2[0]);
      const raw = src.slice(pos, pos + o + s2.index + g + l2);
      const innerText = raw.slice(o, -o);
      const inner = plain ? inlinePlain(innerText, links, st) : inlineHtml(innerText, links, st);
      return { html: plain ? inner : `<del>${inner}</del>`, len: raw.length };
    }
  }
  return null;
}

// Try a bare URL or email address at `pos` (marked's url rule). Only
// attempted when not already inside a link. Returns { html, len } or
// null. A URL can start on an alphanumeric character — but an email
// address can also start on '.', '_', '+' or '-', so those characters
// attempt this rule too.
function tryUrlAt(src, pos, links, st, plain) {
  if (st.inLink) return null;
  const m = at(S.url, src, pos);
  if (!m) return null;
  let raw = m[0];
  let text;
  let href;
  if (m[2] === '@') {
    text = raw;
    href = 'mailto:' + raw;
  } else {
    let prev;
    do {
      prev = raw;
      const back = I_BACKPEDAL.exec(raw);
      raw = back ? back[0] : '';
    } while (prev !== raw);
    text = raw;
    href = m[1] === 'www.' ? 'http://' + raw : raw;
  }
  if (plain) return { html: text, len: raw.length };
  const url = cleanUrl(href);
  return { html: url === null ? esc(text, true) : `<a href="${esc(url, true)}">${esc(text, true)}</a>`, len: raw.length };
}

// The inline loop, dispatched on the first character at the cursor: each
// rule can only start with one of a few characters, so a position that
// cannot start a rule skips straight to the text rule instead of running
// eleven sticky regexes that all fail. Within a first-character group
// the attempt order is exactly marked's: escape before hard break,
// tag before autolink, link before reference link, and the text rule
// last. A position that matches no rule in its group falls through to
// the text rule below.
function inlineLoop(src, links, st, plain) {
  const getMask = makeMask(src, links);
  const leanText = !URL_TRIGGER.test(src);
  let out = '';
  let pos = 0;
  let prevChar = '';
  let prevText = false;
  const end = src.length;
  let guard = Infinity;
  while (pos < end) {
    const remain = end - pos;
    if (remain >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    guard = remain;
    if (!prevText) prevChar = '';
    prevText = false;
    const ch = src[pos];

    if (ch === '\\') {
      const m = at(S.escape, src, pos);
      if (m) {
        out += plain ? m[1] : esc(m[1]);
        pos += m[0].length;
        continue;
      }
      const br = at(S.br, src, pos);
      if (br) {
        if (!plain) out += '<br>';
        pos += br[0].length;
        continue;
      }
    } else if (ch === '<') {
      const m = at(S.tag, src, pos);
      if (m) {
        const tagHtml = m[0];
        if (!st.inLink && /^<a /i.test(tagHtml)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tagHtml)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tagHtml)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tagHtml)) st.inRawBlock = false;
        out += tagHtml;
        pos += tagHtml.length;
        continue;
      }
      const auto = at(S.autolink, src, pos);
      if (auto) {
        const text = auto[1];
        const href = auto[2] === '@' ? 'mailto:' + text : text;
        if (plain) {
          out += text;
        } else {
          const url = cleanUrl(href);
          out += url === null ? esc(text, true) : `<a href="${esc(url, true)}">${esc(text, true)}</a>`;
        }
        pos += auto[0].length;
        continue;
      }
    } else if (ch === '[' || ch === '!') {
      const link = tryLink(src, pos, links, st, plain);
      if (link) {
        out += link.html;
        pos += link.len;
        continue;
      }
      const ref = tryRefLink(src, pos, links, st, plain);
      if (ref) {
        out += ref.html;
        pos += ref.len;
        continue;
      }
    } else if (ch === '*') {
      const em = tryEmStrong(src, pos, getMask, prevChar, links, st, plain);
      if (em) {
        out += em.html;
        pos += em.len;
        continue;
      }
    } else if (ch === '_') {
      const em = tryEmStrong(src, pos, getMask, prevChar, links, st, plain);
      if (em) {
        out += em.html;
        pos += em.len;
        continue;
      }
      // An email address may start with '_', so the url rule is
      // attempted here too, exactly as in the unsplit loop order.
      const u = tryUrlAt(src, pos, links, st, plain);
      if (u) {
        out += u.html;
        pos += u.len;
        continue;
      }
    } else if (ch === '.' || ch === '+' || ch === '-') {
      // No other inline rule starts on these, but an email address can.
      const u = tryUrlAt(src, pos, links, st, plain);
      if (u) {
        out += u.html;
        pos += u.len;
        continue;
      }
    } else if (ch === '`') {
      const m = at(S.codespan, src, pos);
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        const hasNonSpace = /[^ ]/.test(text);
        if (hasNonSpace && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
        out += plain ? text : `<code>${esc(text, true)}</code>`;
        pos += m[0].length;
        continue;
      }
    } else if (ch === '~') {
      const del = tryDel(src, pos, getMask, prevChar, links, st, plain);
      if (del) {
        out += del.html;
        pos += del.len;
        continue;
      }
    } else if (
      (ch >= '0' && ch <= '9') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z')
    ) {
      const u = tryUrlAt(src, pos, links, st, plain);
      if (u) {
        out += u.html;
        pos += u.len;
        continue;
      }
    } else if (ch === ' ') {
      const br = at(S.br, src, pos);
      if (br) {
        if (!plain) out += '<br>';
        pos += br[0].length;
        continue;
      }
    }

    const tm = at(leanText ? S.inlineTextLean : S.inlineText, src, pos);
    if (tm) {
      const raw = tm[0];
      const text = st.inRawBlock ? raw : unesc(raw);
      out += plain ? text : st.inRawBlock ? text : esc(text);
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      prevText = true;
      pos += raw.length;
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block lexing
//
// lexBlocks turns a source into a flat list of block nodes. A node carries
// its kind `k`, the exact source it consumed (`raw`, needed for the merge
// rules below), and the data its rendering needs. Inline content stays as
// source text on the node and is rendered later, once every link reference
// definition in the document has been collected — marked defers inline
// parsing for the same reason. `nested` is true when lexing inside a
// blockquote (a paragraph then merges into a preceding one); `top` is
// false inside list items (paragraphs become bare text blocks there).

// Can the next line after the line starting at `pos` be a table delimiter
// row? A delimiter row consists only of spaces, tabs, '|', ':' and '-',
// with at least one '-'. Anything else means the table rule cannot
// match here, so it is skipped without running its regex. This is a
// superset of what the table rule accepts (it allows no tabs), so a
// false answer is exact and a true answer only costs the attempt.
function nextLineIsTableDelim(src, pos) {
  const nl1 = src.indexOf('\n', pos);
  if (nl1 === -1) return false;
  const start = nl1 + 1;
  const end = src.indexOf('\n', start);
  const e = end === -1 ? src.length : end;
  let hasDash = false;
  for (let i = start; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c === 45) hasDash = true;
    else if (c !== 32 && c !== 9 && c !== 58 && c !== 124) return false;
  }
  return hasDash;
}

function lexBlocks(src, links, nested, top, into) {
  const nodes = into || [];
  // Setext headings need an underline line somewhere in this source.
  // When there is none, the setext rule can never match and is skipped
  // at every position. Computed per call on this call's own source:
  // nested sources (blockquote and list item text) are re-indented, so
  // an outer source without such a line can still contain one inside.
  const noSetext = !hasSetextLine(src);
  // `top` is marked's lexer.state.top: whether a paragraph token may be
  // produced here instead of a text token. It is mutable within this
  // call — lexing a nested list leaves it true (marked's blockTokens
  // returns with state.top set), so text after a nested list inside a
  // list item becomes a paragraph. A blockquote restores it, so it is
  // untouched there.
  let topNow = top;
  let pos = 0;
  const end = src.length;
  let guard = Infinity;
  while (pos < end) {
    const remain = end - pos;
    if (remain >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    guard = remain;
    let m;
    // First-character dispatch: every block rule below can only start with
    // one of a few characters, so a line starting with anything else skips
    // it without running the regex at all.
    const ch = src[pos];
    const isSpace = ch === ' ' || ch === '\t';
    const isDigit = ch >= '0' && ch <= '9';

    if (isSpace || ch === '\n') m = at(S.space, src, pos);
    if (m) {
      pos += m[0].length;
      const prev = nodes[nodes.length - 1];
      if (m[0].length === 1 && prev !== undefined) prev.raw += '\n';
      else nodes.push({ k: 'space', raw: m[0] });
      continue;
    }

    if (isSpace) m = at(S.code, src, pos);
    if (m) {
      const raw = stripBlankTail(m[0]);
      const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
      pos += raw.length;
      const prev = nodes[nodes.length - 1];
      if (prev && (prev.k === 'para' || prev.k === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + text;
      } else {
        nodes.push({ k: 'code', raw, lang: '', text });
      }
      continue;
    }

    if (isSpace || ch === '`' || ch === '~') m = at(S.fences, src, pos);
    if (m) {
      const raw = m[0];
      const lang = m[2] ? m[2].trim().replace(I_ANYPUNCT, '$1') : m[2];
      let text = m[3] || '';
      const ind = /^(\s+)(?:```)/.exec(raw);
      if (ind) {
        const w = ind[1];
        text = text
          .split('\n')
          .map((line) => {
            const lead = /^[ \t]+/.exec(line);
            if (!lead) return line;
            return line.slice(Math.min(lead[0].length, w.length));
          })
          .join('\n');
      }
      nodes.push({ k: 'code', raw, lang, text });
      pos += raw.length;
      continue;
    }

    if (isSpace || ch === '#') m = at(S.heading, src, pos);
    if (m) {
      let text = m[2].trim();
      if (/#$/.test(text)) {
        const stripped = trimEndChar(text, '#');
        if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
      }
      const raw = trimEndChar(m[0], '\n');
      nodes.push({ k: 'heading', raw, depth: m[1].length, text });
      pos += raw.length;
      continue;
    }

    if (isSpace || ch === '-' || ch === '_' || ch === '*') m = at(S.hr, src, pos);
    if (m) {
      const raw = trimEndChar(m[0], '\n');
      nodes.push({ k: 'hr', raw });
      pos += raw.length;
      continue;
    }

    if (isSpace || ch === '>') {
      const bq = lexBlockquote(src, pos, links);
      if (bq) {
        nodes.push(bq.node);
        pos += bq.len;
        continue;
      }
    }

    if (isSpace || ch === '*' || ch === '-' || ch === '+' || isDigit) {
      const list = lexList(src, pos, links);
      if (list) {
        nodes.push(list.node);
        pos += list.len;
        // A nested list's item lexing leaves state.top true.
        topNow = true;
        continue;
      }
    }

    if (isSpace || ch === '<') m = at(S.html, src, pos);
    if (m) {
      const raw = stripBlankTail(m[0]);
      nodes.push({ k: 'html', raw, text: raw });
      pos += raw.length;
      continue;
    }

    if (isSpace || ch === '[') m = at(S.def, src, pos);
    if (m) {
      const hrefRaw = m[2];
      if (/^</.test(hrefRaw) || parenBalance(hrefRaw, '(', ')') === -1) {
        const tag = labelKey(m[1]);
        const href = hrefRaw.replace(/^<(.*)>$/, '$1').replace(I_ANYPUNCT, '$1');
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(I_ANYPUNCT, '$1') : m[3];
        const raw = trimEndChar(m[0], '\n');
        const prev = nodes[nodes.length - 1];
        if (prev && (prev.k === 'para' || prev.k === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + raw;
        } else {
          if (!Object.hasOwn(links, tag)) links[tag] = { href, title };
          nodes.push({ k: 'def', raw });
        }
        pos += raw.length;
        continue;
      }
    }

    if (nextLineIsTableDelim(src, pos)) {
      m = at(S.table, src, pos);
      if (m && /[:|]/.test(m[2])) {
        const headerCells = splitRow(m[1]);
        const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
        if (headerCells.length === aligns.length) {
          const align = aligns.map((a) =>
            /^ *-+: *$/.test(a) ? 'right' : /^ *:-+: *$/.test(a) ? 'center' : /^ *:-+ *$/.test(a) ? 'left' : null
          );
          const body = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
          const raw = trimEndChar(m[0], '\n');
          nodes.push({
            k: 'table',
            raw,
            header: headerCells.map((c, i) => ({ text: c, align: align[i] })),
            rows: body.map((r) => splitRow(r, headerCells.length).map((c, i) => ({ text: c, align: align[i] }))),
          });
          pos += raw.length;
          continue;
        }
      }
    }

    if (!noSetext) {
      m = at(S.lheading, src, pos);
      if (m) {
        const raw = trimEndChar(m[0], '\n');
        nodes.push({ k: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() });
        pos += raw.length;
        continue;
      }
    }

    if (topNow) {
      m = at(S.paragraph, src, pos);
      if (m) {
        const raw = m[0];
        const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        const prev = nodes[nodes.length - 1];
        if (nested && prev && prev.k === 'para') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + text;
        } else {
          nodes.push({ k: 'para', raw, text });
        }
        // The merge flag is spent after the first paragraph of this call
        // (marked: n = o.length !== e.length, which is false without
        // extensions), so later paragraphs in the same call stay separate.
        nested = false;
        pos += raw.length;
        continue;
      }
    }

    m = at(S.text, src, pos);
    if (m) {
      const raw = m[0];
      const prev = nodes[nodes.length - 1];
      if (prev && prev.k === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
      } else {
        nodes.push({ k: 'text', raw, text: raw });
      }
      pos += raw.length;
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return nodes;
}

// Collect the inline sources (paragraph / text / heading text and table
// cell text) under a block node, in document order. A node that is itself
// a re-lex replacement contributes its stored orphan sources first:
// in marked's inline queue those ran before the node's real content.
// Used for the orphaned-pass leak (see replayOrphan).
function collectInlineSources(node, out) {
  if (!node) return out;
  if (node.orphan) for (const t of node.orphan) out.push(t);
  switch (node.k) {
    case 'para':
    case 'text':
    case 'heading':
      out.push(node.text);
      break;
    case 'blockquote':
      for (const c of node.nodes) collectInlineSources(c, out);
      break;
    case 'list':
      for (const item of node.items) for (const c of item.nodes) collectInlineSources(c, out);
      break;
    case 'table':
      for (const c of node.header) out.push(c.text);
      for (const row of node.rows) for (const c of row) out.push(c.text);
      break;
    default:
      break;
  }
  return out;
}

// Replay an orphaned inline pass. When a blockquote re-lexes a nested
// blockquote or list, marked still runs the discarded first pass's
// inline tokenization, and an unclosed <a> tag in it leaves inLink set
// for the real pass (inRawBlock is reset before every inline pass, so
// only inLink leaks). The replacement node carries the orphaned
// sources; running them here, output discarded, reproduces that state
// exactly at the point the orphaned pass would have run.
function replayOrphan(n, links, st) {
  if (!n.orphan) return;
  for (const t of n.orphan) {
    st.inRawBlock = false;
    inlineHtml(t, links, st);
  }
}

// A blockquote at `pos`, or null. Returns { node, len }.
function lexBlockquote(src, pos, links) {
  const m = at(S.blockquote, src, pos);
  if (!m) return null;
  let lines = trimEndChar(m[0], '\n').split('\n');
  let rawAcc = '';
  let textAcc = '';
  const nodes = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (/^ {0,3}>/.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(/^( {0,3}>)([ \t]+)/gm, (g, b, sp) => b + expandTabs(sp, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    rawAcc = rawAcc ? rawAcc + '\n' + h : h;
    textAcc = textAcc ? textAcc + '\n' + u : u;
    const inner = lexBlocks(u, links, true, true, nodes);
    if (lines.length === 0) break;
    const k = nodes[nodes.length - 1];
    if (!k) break;
    if (k.k === 'code' || k.k === 'heading' || k.k === 'hr' || k.k === 'html' || k.k === 'table') break;
    if (k.k === 'blockquote') {
      const b = lines.join('\n');
      const src2 = k.raw + '\n' + b.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = lexBlockquote(src2, 0, links);
      const orphan = collectInlineSources(k, []);
      if (orphan.length > 0) f.node.orphan = orphan;
      nodes[nodes.length - 1] = f.node;
      const y = src2.substring(f.node.raw.length).replace(/^\n/, '');
      const r = y ? y.split('\n').length : 0;
      const taken = r ? lines.slice(0, -r) : lines;
      if (taken.length > 0) rawAcc += '\n' + taken.join('\n');
      textAcc = textAcc.substring(0, textAcc.length - k.text.length) + f.node.text;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && /^ {0,3}>/.test(lines[0])) continue;
      break;
    } else if (k.k === 'list') {
      const b = k.raw + '\n' + lines.join('\n');
      const f = lexList(b, 0, links);
      const orphan = collectInlineSources(k, []);
      if (orphan.length > 0) f.node.orphan = orphan;
      nodes[nodes.length - 1] = f.node;
      const extra =
        f.node.raw.length > k.raw.length ? b.slice(k.raw.length + 1, f.node.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const y = lines.slice(0, extra).join('\n');
        rawAcc += '\n' + y;
        textAcc += '\n' + y;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { node: { k: 'blockquote', raw: rawAcc, text: textAcc, nodes }, len: rawAcc.length };
}

// Do any of the list-item break rules match at the start of `line`? The
// six rules are all anchored with up to `ci` spaces, so the first
// non-space character decides which of them can possibly match: a tab
// before it, or more than `ci` spaces, blocks all of them. `withBullet`
// is false for the second check inside the loop, where the bullet rule
// and the blockquote rule are not tested.
function breaksLine(line, ci, fencesRe, headingRe, htmlRe, bqRe, nextBullet, hrRe, withBullet) {
  let i = 0;
  let spaces = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      spaces++;
      i++;
    } else if (c === 9) {
      return false;
    } else {
      break;
    }
  }
  if (spaces > ci) return false;
  const c = line.charCodeAt(i);
  if (c === 96 || c === 126) return !!at(fencesRe, line, 0);
  if (c === 35) return !!at(headingRe, line, 0);
  if (c === 60) return !!at(htmlRe, line, 0);
  if (c === 62) return withBullet && !!at(bqRe, line, 0);
  if (c === 42 || c === 45 || c === 43) {
    return withBullet ? !!at(nextBullet, line, 0) || !!at(hrRe, line, 0) : !!at(hrRe, line, 0);
  }
  if (c >= 48 && c <= 57) return withBullet && !!at(nextBullet, line, 0);
  if (c === 95) return !!at(hrRe, line, 0);
  return false;
}

// A list at `pos`, or null. Returns { node, len }.
function lexList(src, pos, links) {
  const first = at(S.list, src, pos);
  if (!first) return null;
  const origin = pos;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const node = {
    k: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = sticky(listItemRe(bulletPat));
  let p = pos;
  let prevBlankEnded = false;
  while (p < src.length) {
    let empty = false;
    let text = '';
    const itemMatch = at(itemRe, src, p);
    if (!itemMatch || at(S.hr, src, p)) break;
    const itemStart = p - origin;
    p += itemMatch[0].length;
    const firstLine = itemMatch[2].split('\n', 1)[0];
    const bulletLen = itemMatch[1].length;
    const expanded = expandLead(firstLine, bulletLen);
    const nl = src.indexOf('\n', p);
    const next = nl === -1 ? src.slice(p) : src.slice(p, nl);
    let blankFirst = !expanded.trim();
    let indent;
    if (blankFirst) {
      indent = bulletLen + 1;
    } else {
      indent = firstNonSpace(expanded);
      if (indent > 4) indent = 1;
      text = expanded.slice(indent);
      indent += bulletLen;
    }
    if (blankFirst && /^[ \t]*$/.test(next)) {
      p = nl === -1 ? src.length : nl + 1;
      empty = true;
    }
    if (!empty) {
      const ci = clampIndent(indent);
      const nextBullet = S_NEXT_BULLET[ci];
      const hrRe = S_HR_INDENT[ci];
      const fencesRe = S_FENCES_BEGIN[ci];
      const headingRe = S_HEADING_BEGIN[ci];
      const htmlRe = S_HTML_BEGIN[ci];
      const bqRe = S_BLOCKQUOTE_BEGIN[ci];
      let cur = expanded;
      while (p < src.length) {
        const nl2 = src.indexOf('\n', p);
        const line = nl2 === -1 ? src.slice(p) : src.slice(p, nl2);
        const after = nl2 === -1 ? src.length : nl2 + 1;
        const expandedLine = expandLead(line, 0);
        if (breaksLine(line, ci, fencesRe, headingRe, htmlRe, bqRe, nextBullet, hrRe, true)) {
          break;
        }
        const ns = firstNonSpace(expandedLine);
        if (ns >= indent || !line.trim()) {
          text += '\n' + expandedLine.slice(indent);
        } else {
          // Lazy continuation: the line belongs to this item only when
          // the previous line was blank, or its content starts at least
          // four columns in (tabs counted as four spaces), or no break
          // rule matches the previous line's remainder.
          let ce = -1;
          let epos = 0;
          for (let cn = 0; cn < cur.length; cn++) {
            const cc = cur.charCodeAt(cn);
            if (cc === 32) epos += 1;
            else if (cc === 9) epos += 4;
            else {
              ce = epos;
              break;
            }
          }
          if (
            blankFirst ||
            ce >= 4 ||
            breaksLine(cur, ci, fencesRe, headingRe, htmlRe, bqRe, nextBullet, hrRe, false)
          ) {
            break;
          }
          // A setext underline is still checked here, after the break
          // conditions above: for '* item\n  text\n---', the '---'
          // must hit the hr rule first and close the list.
          const setext =
            /^ {0,3}(?:=+|-+) *$/.test(line) && at(S.lheading, cur + '\n' + line, 0)
              ? '    ' + expandedLine.replace(/^ {0,3}/, '')
              : line;
          text += '\n' + setext;
        }
        blankFirst = !line.trim();
        p = after;
        cur = expandedLine.slice(indent);
      }
    }
    const itemRaw = src.slice(origin + itemStart, p);
    if (!node.loose) {
      if (prevBlankEnded) node.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(itemRaw)) prevBlankEnded = true;
    }
    node.items.push({
      raw: itemRaw,
      task: /^\[[ xX]\][ \t]+\S/.test(text),
      loose: false,
      text,
      nodes: [],
    });
  }
  const last = node.items[node.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  node.raw = src.slice(origin, p).trimEnd();
  // Lex each item's text with top=false, and decide looseness.
  for (const item of node.items) {
    item.nodes = lexBlocks(item.text, links, false, false);
    if (!node.loose) {
      const spaces = item.nodes.filter((n) => n.k === 'space');
      if (spaces.length > 0 && spaces.some((n) => /\n.*\n/.test(n.raw))) node.loose = true;
    }
  }
  // Task list items: strip the marker, add a checkbox node.
  for (const item of node.items) {
    const firstNode = item.nodes[0];
    if (item.task && firstNode && (firstNode.k === 'text' || firstNode.k === 'para')) {
      item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
      firstNode.raw = firstNode.raw.replace(/^\[[ xX]\][ \t]+/, '');
      firstNode.text = firstNode.text.replace(/^\[[ xX]\][ \t]+/, '');
      const cb = /\[[ xX]\]/.exec(item.raw);
      if (cb) {
        const checked = cb[0] !== '[ ]';
        item.checked = checked;
        const box = { k: 'checkbox', raw: cb[0] + ' ', checked };
        if (node.loose) {
          firstNode.checkbox = box;
        } else {
          item.nodes.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (node.loose) {
    for (const item of node.items) {
      item.loose = true;
      for (const n of item.nodes) if (n.k === 'text') n.k = 'para';
    }
  }
  return { node, len: node.raw.length };
}

// ---------------------------------------------------------------------------
// Block rendering
//
// One pass over the nodes; a node's inline source is rendered on demand,
// after the whole document's link reference definitions have been seen.

function renderBlocks(nodes, links, st) {
  let out = '';
  for (const n of nodes) out += renderBlock(n, links, st);
  return out;
}

// Render one block node's inline source. marked resets inRawBlock before
// every inline parse, so a <pre> opened in one paragraph never leaks into
// the next; the recursive label renders inside outputLink do not reset it.
function topInline(text, links, st) {
  st.inRawBlock = false;
  return inlineHtml(text, links, st);
}

function renderBlock(n, links, st) {
  switch (n.k) {
    case 'space':
      return '';
    case 'code': {
      const lang = (n.lang || '').match(/^\S*/)?.[0] ?? '';
      const text = n.text ? n.text.replace(/\n$/, '') + '\n' : '';
      return (
        '<pre><code' +
        (lang ? ' class="language-' + esc(lang) + '"' : '') +
        '>' +
        esc(text, true) +
        '</code></pre>\n'
      );
    }
    case 'heading':
      return '<h' + n.depth + '>' + topInline(n.text, links, st) + '</h' + n.depth + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'blockquote':
      replayOrphan(n, links, st);
      return '<blockquote>\n' + renderBlocks(n.nodes, links, st) + '</blockquote>\n';
    case 'html':
      return n.text;
    case 'def':
      return '';
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (const c of n.header) {
        out += '<th' + (c.align ? ' align="' + c.align + '"' : '') + '>' + topInline(c.text, links, st) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (n.rows.length > 0) {
        out += '<tbody>';
        for (const row of n.rows) {
          out += '<tr>\n';
          for (const c of row) {
            out += '<td' + (c.align ? ' align="' + c.align + '"' : '') + '>' + topInline(c.text, links, st) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    case 'para':
      return '<p>' + (n.checkbox ? renderBlock(n.checkbox, links, st) : '') + topInline(n.text, links, st) + '</p>\n';
    case 'text':
      return (n.checkbox ? renderBlock(n.checkbox, links, st) : '') + topInline(n.text, links, st);
    case 'checkbox':
      return '<input ' + (n.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'list': {
      replayOrphan(n, links, st);
      let out = '<' + (n.ordered ? 'ol' : 'ul');
      if (n.ordered && n.start !== 1) out += ' start="' + n.start + '"';
      out += '>\n';
      for (const item of n.items) {
        out += '<li>' + renderBlocks(item.nodes, links, st) + '</li>\n';
      }
      out += '</' + (n.ordered ? 'ol' : 'ul') + '>\n';
      return out;
    }
    default:
      return '';
  }
}

// The entry point: marked.parse's default options (gfm, no breaks, no
// pedantic, synchronous). Line endings are normalised first, exactly as
// marked's lexer does — but only when the source actually contains a
// carriage return, which most inputs do not.
export function parse(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const links = {};
  const nodes = lexBlocks(src, links, false, true);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  return renderBlocks(nodes, links, st);
}
