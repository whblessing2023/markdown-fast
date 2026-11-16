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
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  {
    protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
    [/emailProtocol/g]: /(?:mailto|xmpp):/,
    wwwStart: /(?<![^\s*_~(])www\./,
  }
);
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
  t = t.replace(I_ANYPUNCT_OUTSIDE_CODE, (whole, ticks, punct) =>
    punct
      ? '+'.repeat(whole.length)
      : ticks
        ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
        : whole
  );
  t = t.replace(I_BLOCKSKIP, (whole) => '[' + 'a'.repeat(whole.length - 2) + ']');
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
  const p = l === 0 ? '' : [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || I_PUNCT.test(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : I_PUNCT.test(n);
  if (s[4] && /[\p{L}\p{N}]/u.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
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
      b = [...g].length;
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
      const te = [...s2[0]][0].length;
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
    const o = [...s[0]].length - 1;
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
      l2 = [...i2].length;
      if (l2 !== o) continue;
      if (s2[3] || s2[4]) {
        p += l2;
        continue;
      }
      p -= l2;
      if (p > 0) continue;
      l2 = Math.min(l2, l2 + p);
      const g = [...s2[0]][0].length;
      const raw = src.slice(pos, pos + o + s2.index + g + l2);
      const innerText = raw.slice(o, -o);
      const inner = plain ? inlinePlain(innerText, links, st) : inlineHtml(innerText, links, st);
      return { html: plain ? inner : `<del>${inner}</del>`, len: raw.length };
    }
  }
  return null;
}

function inlineLoop(src, links, st, plain) {
  const getMask = makeMask(src, links);
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

    let m = at(S.escape, src, pos);
    if (m) {
      out += plain ? m[1] : esc(m[1]);
      pos += m[0].length;
      continue;
    }

    m = at(S.tag, src, pos);
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

    {
      const em = tryEmStrong(src, pos, getMask, prevChar, links, st, plain);
      if (em) {
        out += em.html;
        pos += em.len;
        continue;
      }
    }

    m = at(S.codespan, src, pos);
    if (m) {
      let text = m[2].replace(/\n/g, ' ');
      const hasNonSpace = /[^ ]/.test(text);
      if (hasNonSpace && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
      out += plain ? text : `<code>${esc(text, true)}</code>`;
      pos += m[0].length;
      continue;
    }

    m = at(S.br, src, pos);
    if (m) {
      if (!plain) out += '<br>';
      pos += m[0].length;
      continue;
    }

    {
      const del = tryDel(src, pos, getMask, prevChar, links, st, plain);
      if (del) {
        out += del.html;
        pos += del.len;
        continue;
      }
    }

    m = at(S.autolink, src, pos);
    if (m) {
      const text = m[1];
      const href = m[2] === '@' ? 'mailto:' + text : text;
      if (plain) {
        out += text;
      } else {
        const url = cleanUrl(href);
        out += url === null ? esc(text, true) : `<a href="${esc(url, true)}">${esc(text, true)}</a>`;
      }
      pos += m[0].length;
      continue;
    }

    if (!st.inLink) {
      m = at(S.url, src, pos);
      if (m) {
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
        if (plain) {
          out += text;
        } else {
          const url = cleanUrl(href);
          out += url === null ? esc(text, true) : `<a href="${esc(url, true)}">${esc(text, true)}</a>`;
        }
        pos += raw.length;
        continue;
      }
    }

    m = at(S.inlineText, src, pos);
    if (m) {
      const raw = m[0];
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

function lexBlocks(src, links, nested, top, into) {
  const nodes = into || [];
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

    m = at(S.lheading, src, pos);
    if (m) {
      const raw = trimEndChar(m[0], '\n');
      nodes.push({ k: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() });
      pos += raw.length;
      continue;
    }

    if (top) {
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

// The next line of `src` at `pos`: { line, next } where `next` is the
// position just past the line's newline (or the end of the source).
function nextLine(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return { line: src.slice(pos), next: src.length };
  return { line: src.slice(pos, nl), next: nl + 1 };
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
    const expanded = firstLine.replace(/^[ \t]+/, (v) => expandTabs(v, bulletLen));
    let { line: next } = nextLine(src, p);
    let blankFirst = !expanded.trim();
    let indent;
    if (blankFirst) {
      indent = bulletLen + 1;
    } else {
      indent = expanded.search(/[^ ]/);
      if (indent > 4) indent = 1;
      text = expanded.slice(indent);
      indent += bulletLen;
    }
    if (blankFirst && /^[ \t]*$/.test(next)) {
      p = nextLine(src, p).next;
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
        const { line: lineRaw, next: after } = nextLine(src, p);
        const line = lineRaw;
        const expandedLine = line.replace(/^[ \t]+/, (v) => expandTabs(v, 0));
        if (
          at(fencesRe, line, 0) ||
          at(headingRe, line, 0) ||
          at(htmlRe, line, 0) ||
          at(bqRe, line, 0) ||
          at(nextBullet, line, 0) ||
          at(hrRe, line, 0)
        ) {
          break;
        }
        if (expandedLine.search(/[^ ]/) >= indent || !line.trim()) {
          text += '\n' + expandedLine.slice(indent);
        } else {
          if (
            blankFirst ||
            cur.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
            at(fencesRe, cur, 0) ||
            at(headingRe, cur, 0) ||
            at(htmlRe, cur, 0) ||
            at(hrRe, cur, 0)
          ) {
            break;
          }
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
// marked's lexer does.
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const links = {};
  const nodes = lexBlocks(src, links, false, true);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  return renderBlocks(nodes, links, st);
}
