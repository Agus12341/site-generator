// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree makefun-site's build
// returns for the same input, byte for byte, on every case. The pipeline follows makefun-site's own rules
// (its README and code are the reference); the hot paths are written to scan strings by char code, to work
// on ranges of the string already in hand instead of slicing copies, and to reuse what a build computes
// more than once (a post's card, a date's long form, a template loop's scope).

// ---------------------------------------------------------------- text

/** `text` with & < > " and ' escaped, and nothing else; the input itself when there is nothing to escape. */
export function escapeHtml(text) {
  let out = '';
  let last = 0;
  let found = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += text.slice(last, i) + rep;
      last = i + 1;
      found = true;
    }
  }
  return found ? out + text.slice(last) : text;
}

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z
 * and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), and
 * "untitled" when nothing is left. Pure-ASCII text takes a fast path: ASCII has no decompositions and no
 * combining marks, so normalisation would change nothing.
 */
export function slugify(text) {
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) {
      ascii = false;
      break;
    }
    if (c >= 65 && c <= 90) {
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(c + 32);
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) out += '-';
      gap = false;
      out += text[i];
    } else {
      gap = out.length > 0;
    }
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      if (c >= 65 && c <= 90) {
        if (gap) out += '-';
        gap = false;
        out += String.fromCharCode(c + 32);
      } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
        if (gap) out += '-';
        gap = false;
        out += plain[i];
      } else {
        gap = out.length > 0;
      }
    }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** Whether `code` is one of JavaScript's \s characters. */
function isSpaceCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace, counted in a single pass. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    // The common case has no escape and no stray quote inside: the value is the slice between the quotes.
    let plain = true;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92 || c === 34) {
        plain = false;
        break;
      }
    }
    if (plain) return { value: raw.slice(1, raw.length - 1) };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** A YYYY-MM-DD date in range, checked digit by digit. */
function dateOk(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateOk(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      // [a-z0-9]+ groups joined by single "-", at most 64 characters.
      let ok = raw.length >= 1 && raw.length <= 64;
      let group = 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          ok = group > 0;
          group = 0;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) group++;
        else ok = false;
      }
      if (group === 0) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. The lines are walked by offset, so the body stays one slice of the source.
 */
export function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  if ((nl0 === -1 ? text : text.slice(0, nl0)) !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  // Collect the front matter lines and find the closing "---".
  const fmLines = [];
  let body = null;
  let pos = nl0 + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      body = nl === -1 ? '' : text.slice(nl + 1);
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (body === null) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of a-z and "_", a colon, then either the line's end or one space and the value.
    let i = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if ((c >= 97 && c <= 122) || c === 95) i++;
      else break;
    }
    let key = null;
    let raw = '';
    if (i > 0 && line.charCodeAt(i) === 58) {
      if (i === line.length - 1) {
        key = line.slice(0, i);
      } else if (line.charCodeAt(i + 1) === 32) {
        key = line.slice(0, i);
        raw = line.slice(i + 2);
      }
    }
    if (key === null) return { error: `line ${k + 2} is not "key: value"` };
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c === 32 || c === 9) end--;
      else break;
    }
    if (end !== raw.length) raw = raw.slice(0, end);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- markdown

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's opening line: its language, or null. Three backticks, language characters, spaces/tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length) {
    const cc = line.charCodeAt(i);
    if (cc === 32 || cc === 9) i++;
    else break;
  }
  let end = line.length;
  while (end > i) {
    const cc = line.charCodeAt(end - 1);
    if (cc === 32 || cc === 9) end--;
    else break;
  }
  if (end === i) return null;
  return { depth: n, text: line.slice(i, end) };
}

/** Whether `line` is a thematic break: "---" or "***", then spaces or tabs only. */
function isBreak(line) {
  const a = line.charCodeAt(0);
  if (a !== line.charCodeAt(1) || a !== line.charCodeAt(2)) return false;
  if (a !== 45 && a !== 42) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text on `line` (a "-" or "*" and one space), or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item on `line`: { number, text } for 1-9 digits, ". ", or null. */
function orderedText(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { number: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinuation(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isSpaceCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isBreak(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, within [from, b), or -1. */
function findUnescaped(s, what, from, b) {
  const wlen = what.length;
  for (let j = from; j <= b - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < b && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, within [from, b), or -1. */
function findSingleStar(s, from, b) {
  for (let j = from; j < b; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < b && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < b && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline, pushed onto `out`; `env.link(target)` is a link's href. Working on a range
 * of the caller's string keeps strong, emphasis and link contents from being copied before they render.
 */
function inlineRange(s, a, b, env, out) {
  let i = a;
  while (i < b) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1);
      if (j === -1 || j >= b) j = -1;
      if (j > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m >= b) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // A plain stretch: everything up to the next character that can open a construct, escaped in one go.
    let j = i + 1;
    while (j < b) {
      const cc = s[j];
      if (cc === '\\' || cc === '`' || cc === '*' || cc === '[') break;
      j++;
    }
    out.push(escapeHtml(s.slice(i, j)));
    i = j;
  }
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
export function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents
 * (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or ""). Blocks are rendered as they are lexed, into one list of pieces.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < lines.length && !isFenceClose(lines[i])) {
        body.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      out.push('<pre><code', lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`, '>', body.join(''), '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const parts = [];
      inlineRange(heading.text, 0, heading.text.length, env, parts);
      const html = parts.join('');
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreak(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        body.push(trimLine(raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1)));
        i++;
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        const parts = [];
        inlineRange(joined, 0, joined.length, env, parts);
        out.push('<blockquote>\n<p>', parts.join(''), '</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedText(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const rest = isOrdered ? orderedText(lines[i]) : bulletText(lines[i]);
        if (rest !== null) {
          items.push([trimLine(isOrdered ? rest.text : rest)]);
          i++;
        } else if (isContinuation(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && ordered.number !== 1 ? `<ol start="${ordered.number}">\n` : `<${tag}>\n`);
      for (const parts of items) {
        const item = parts.join('\n');
        const rendered = [];
        inlineRange(item, 0, item.length, env, rendered);
        out.push('<li>', rendered.join(''), '</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const text = body.join('\n');
    const parts = [];
    inlineRange(text, 0, text.length, env, parts);
    const html = parts.join('');
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

function templateError(name, reason) {
  return new TemplateError(`template "${name}": ${reason}`);
}

/** Whether `text` is a path: names of [A-Za-z0-9_] from a letter or "_", joined by dots. */
function isPath(text) {
  if (text.length === 0) return false;
  let seg = 0; // characters in the current name; 0 at a name's start
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46) {
      if (seg === 0) return false;
      seg = 0;
      continue;
    }
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    const digit = c >= 48 && c <= 57;
    if (seg === 0 ? !letter : !(letter || digit)) return false;
    seg++;
  }
  return seg > 0;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!isPath(text)) throw templateError(name, `${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `text` holds no whitespace (a \S+ match). */
function noSpace(text) {
  for (let i = 0; i < text.length; i++) if (isSpaceCode(text.charCodeAt(i))) return false;
  return text.length > 0;
}

/** Whether `s[a..b)` is nothing but spaces and tabs. */
function onlyBlank(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw templateError(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw templateError(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlyBlank(src, lineStart, open) && onlyBlank(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A "for <name> in <path>" tag: { name, pathText }, or null. */
function forTag(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  const start = i;
  while (i < tag.length) {
    const c = tag.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) i++;
    else break;
  }
  if (i === start) return null;
  const first = tag.charCodeAt(start);
  if (first >= 48 && first <= 57) return null;
  if (!tag.startsWith(' in ', i)) return null;
  const pathText = tag.slice(i + 4);
  if (!noSpace(pathText)) return null;
  return { name: tag.slice(start, i), pathText };
}

/** An "if [not] <path>" tag: { not, pathText }, or null. */
function ifTag(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ') && rest.length > 4) {
    not = true;
    rest = rest.slice(4);
  }
  if (!noSpace(rest)) return null;
  return { not, pathText: rest };
}

/** An 'include "<name>"' tag: the name, or null. */
function includeTag(tag) {
  if (!tag.startsWith('include "') || tag.charCodeAt(tag.length - 1) !== 34 || tag.length < 10) return null;
  const name = tag.slice(9, tag.length - 1);
  if (name.length === 0) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return name;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const f = forTag(tag);
      if (f !== null) {
        const node = { kind: 'for', name: f.name, path: pathOf(name, f.pathText), body: [], _scope: null, _active: false };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
      const cond = ifTag(tag);
      if (cond !== null) {
        const node = { kind: 'if', not: cond.not, path: pathOf(name, cond.pathText), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
      if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw templateError(name, 'an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw templateError(name, `an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else {
        const inc = includeTag(tag);
        if (inc !== null) body.push({ kind: 'include', name: inc });
        else throw templateError(name, `{% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw templateError(name, `a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), pieces pushed onto `out`. `ctx` holds the parsed
 * templates and the include depth. A for loop reuses its child scope, vars and loop object across
 * iterations; a loop node that is re-entered while it runs (a self-including template) gets fresh ones.
 */
export function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        let cs = n._scope;
        if (cs === null || n._active) cs = { vars: {}, loop: {}, scope: { vars: null, parent: null } };
        if (n._scope === null) n._scope = cs;
        n._active = true;
        cs.scope.vars = cs.vars;
        cs.scope.parent = scope;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          cs.vars[n.name] = xs[k];
          cs.loop.index = k + 1;
          cs.loop.first = k === 0;
          cs.loop.last = k === len - 1;
          cs.loop.length = len;
          cs.vars.loop = cs.loop;
          renderNodes(n.body, cs.scope, ctx, depth, out);
        }
        n._active = false;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` opens with a scheme: a letter, then letters, digits, "+", "-" or ".", then ":". */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const baseUrl = input.site.base_url;
  let baseEnd = baseUrl.length;
  while (baseEnd > 0 && baseUrl.charCodeAt(baseEnd - 1) === 47) baseEnd--;
  const base = baseEnd === baseUrl.length ? baseUrl : baseUrl.slice(0, baseEnd);

  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  const dateLongCache = new Map();
  const dateLong = (date) => {
    let v = dateLongCache.get(date);
    if (v === undefined) {
      v = longDate(date);
      dateLongCache.set(date, v);
    }
    return v;
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        names.push(name);
      }
    }
    return names;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateLong(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : dateLong(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of b.posts) b.cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const card = s.post ? b.cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) } });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
