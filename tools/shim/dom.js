"use strict";
/*
 * 纯 Node 的最小 DOM 实现（无浏览器可用时的替代环境）。
 * 位置：tools/shim/dom.js —— 由 env.js 直接 require，是 tools/shim/* 全部测试的运行环境。
 * 目标：让 **未经修改的** extension/content.js 与 quiz-app/index.html 的内联脚本
 * 能在同一个上下文里跑起来，从而观测真实代码路径的行为与耗时。
 * 明确不实现：真实布局/渲染、CSS 层叠完整语义、表单提交、XHR 之外的网络。
 */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®",
  hellip: "…", mdash: "—", ndash: "–", times: "×", divide: "÷", deg: "°", middot: "·",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019", shy: "\u00ad",
  ensp: " ", emsp: " ", thinsp: " ", bull: "•", dagger: "†", prime: "′", permil: "‰",
  euro: "€", pound: "£", yen: "¥", sect: "§", para: "¶", laquo: "«", raquo: "»",
};

function decodeEntities(s) {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g) => {
    if (g[0] === "#") {
      const hex = g[1] === "x" || g[1] === "X";
      const code = parseInt(hex ? g.slice(2) : g.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    const v = ENTITIES[g.toLowerCase()];
    return v === undefined ? m : v;
  });
}
function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------- Event

class ShimEvent {
  constructor(type, init) {
    this.type = String(type);
    this.bubbles = !!(init && init.bubbles);
    this.cancelable = !!(init && init.cancelable);
    this.defaultPrevented = false;
    this._stopped = false;
    this.target = null;
    this.currentTarget = null;
    if (init) for (const k of Object.keys(init)) if (!(k in this)) this[k] = init[k];
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; }
}

// ---------------------------------------------------------------- Style

class StyleDecl {
  constructor(el) {
    this._el = el;
    this._map = new Map();
  }
  get cssText() {
    return [...this._map.entries()].map(([k, v]) => `${k}: ${v}`).join("; ");
  }
  set cssText(v) {
    this._map.clear();
    String(v || "").split(";").forEach((p) => {
      const i = p.indexOf(":");
      if (i > 0) this._map.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    });
    this._sync();
  }
  setProperty(k, v) { this._map.set(String(k), String(v)); this._sync(); }
  getPropertyValue(k) { return this._map.get(String(k)) || ""; }
  removeProperty(k) { const v = this._map.get(k) || ""; this._map.delete(k); this._sync(); return v; }
  _sync() { this._el._attrs.set("style", this.cssText); }
}

function makeStyle(el) {
  const t = new StyleDecl(el);
  return new Proxy(t, {
    get(o, p) {
      if (typeof p === "string" && !(p in o)) return o._map.get(p) || "";
      const v = o[p];
      return typeof v === "function" ? v.bind(o) : v;
    },
    set(o, p, v) {
      if (p === "cssText") { o.cssText = v; return true; }
      if (typeof p === "string") { o._map.set(p, String(v)); o._sync(); return true; }
      return false;
    },
    has() { return true; },
    ownKeys(o) { return [...o._map.keys()]; },
    getOwnPropertyDescriptor(o, p) {
      if (o._map.has(p)) return { value: o._map.get(p), enumerable: true, configurable: true, writable: true };
      return undefined;
    },
  });
}

// ---------------------------------------------------------------- Node / Element

class Node {
  constructor(doc) {
    this.ownerDocument = doc || null;
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = Object.create(null);
    this.nodeType = 0;
    this.nodeName = "";
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.childNodes.find((c) => c.nodeType === 1) || null; }
  get lastElementChild() { return [...this.childNodes].reverse().find((c) => c.nodeType === 1) || null; }
  get previousSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i > 0 ? this.parentNode.childNodes[i - 1] : null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i >= 0 && i + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[i + 1] : null;
  }
  get previousElementSibling() {
    let n = this.previousSibling;
    while (n && n.nodeType !== 1) n = n.previousSibling;
    return n;
  }
  get nextElementSibling() {
    let n = this.nextSibling;
    while (n && n.nodeType !== 1) n = n.nextSibling;
    return n;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === 9 || (n.nodeType === 1 && n._tag === "html");
  }
  get textContent() {
    if (this.nodeType === 3 || this.nodeType === 8) return this.data;
    let s = "";
    for (const c of this.childNodes) s += c.textContent;
    return s;
  }
  set textContent(v) {
    if (this.nodeType === 3 || this.nodeType === 8) { this.data = String(v == null ? "" : v); return; }
    this._removeAll();
    if (v !== null && v !== undefined && String(v) !== "") {
      this.appendChild(this.ownerDocument.createTextNode(String(v)));
    }
  }
  // 结构一变就要让「文档里的 <style> 列表」缓存失效（见 docStyleEls）。
  // 用独立标志：_orderDirty 会被 _orderIndex() 清掉，不能兼作样式缓存的有效性依据。
  _markStyleDirty() {
    const d = this.ownerDocument;
    if (d) { d._orderDirty = true; d._styleElsDirty = true; }
  }
  _removeAll() {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this._markStyleDirty();
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    this._markStyleDirty();
    return node;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    this._markStyleDirty();
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; this._markStyleDirty(); }
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  getRootNode() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }
  compareDocumentPosition(other) {
    if (this === other) return 0;
    const doc = this.ownerDocument || this;
    const idx = doc._orderIndex ? doc._orderIndex() : null;
    if (!idx) return 1;
    const a = idx.get(this), b = idx.get(other);
    if (a === undefined || b === undefined) return 1;
    return b > a ? 4 : 2; // FOLLOWING | PRECEDING
  }
  addEventListener(type, fn) {
    if (typeof fn !== "function") return;
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const ls = this._listeners[type];
    if (!ls) return;
    const i = ls.indexOf(fn);
    if (i >= 0) ls.splice(i, 1);
  }
  dispatchEvent(ev) {
    ev.target = this;
    const path = [];
    let n = this;
    while (n) { path.push(n); if (!ev.bubbles) break; n = n.parentNode; }
    const win = this.ownerDocument && this.ownerDocument.defaultView;
    if (win && ev.bubbles && path[path.length - 1] !== win) path.push(win);
    for (const node of path) {
      ev.currentTarget = node;
      const ls = node._listeners && node._listeners[ev.type];
      if (ls) for (const fn of [...ls]) {
        if (ev._stopped) break;
        try { fn.call(node, ev); } catch (e) { (this.ownerDocument._errors = this.ownerDocument._errors || []).push(e); }
      }
      if (ev._stopped) break;
    }
    return !ev.defaultPrevented;
  }
}

class TextNode extends Node {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.nodeName = "#text";
    this.data = String(data);
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v == null ? "" : v); }
}

class CommentNode extends Node {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 8;
    this.nodeName = "#comment";
    this.data = String(data);
  }
}

const REFLECTED = ["id", "className", "name", "title", "type", "href", "src", "value",
  "placeholder", "autocomplete", "rel", "role", "for", "alt", "target", "action", "method"];

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this._tag = String(tag).toLowerCase();
    this.tagName = this._tag.toUpperCase();
    this.nodeName = this.tagName;
    this._attrs = new Map();
    this.style = makeStyle(this);
    this._checked = false;
    this._value = undefined;
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get attributes() { return [...this._attrs.entries()].map(([name, value]) => ({ name, value })); }
  getAttribute(name) {
    const v = this._attrs.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }
  setAttribute(name, value) {
    const k = String(name).toLowerCase();
    this._attrs.set(k, String(value));
    if (k === "style") { this.style._map.clear(); const t = new StyleDecl(this); t.cssText = String(value); this.style._map = t._map; }
  }
  removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); }
  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }
  get classList() {
    const self = this;
    const list = () => (self.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    return {
      get length() { return list().length; },
      get value() { return self.getAttribute("class") || ""; },
      contains(c) { return list().includes(c); },
      add(...cs) { const s = new Set(list()); cs.forEach((c) => s.add(c)); self.setAttribute("class", [...s].join(" ")); },
      remove(...cs) { const s = new Set(list()); cs.forEach((c) => s.delete(c)); self.setAttribute("class", [...s].join(" ")); },
      toggle(c, force) {
        const has = list().includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) this.add(c);
        if (!want && has) this.remove(c);
        return want;
      },
      item(i) { return list()[i] || null; },
    };
  }
  get dataset() {
    const self = this;
    const toKey = (k) => k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const toAttr = (k) => "data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    const keys = () => [...self._attrs.keys()].filter((k) => k.startsWith("data-"));
    return new Proxy({}, {
      get(_, p) { if (typeof p !== "string") return undefined; return self.getAttribute(toAttr(p)); },
      set(_, p, v) { self.setAttribute(toAttr(p), v); return true; },
      has(_, p) { return typeof p === "string" && self._attrs.has(toAttr(p)); },
      ownKeys() { return keys(); },
      getOwnPropertyDescriptor(_, p) {
        if (typeof p === "string" && self._attrs.has(toAttr(p))) {
          return { value: self.getAttribute(toAttr(p)), enumerable: true, configurable: true, writable: true };
        }
        return undefined;
      },
    });
  }
  get innerHTML() {
    return this.childNodes.map(serialize).join("");
  }
  set innerHTML(html) {
    this._removeAll();
    parseHtml(String(html == null ? "" : html), this.ownerDocument, this);
  }
  get outerHTML() { return serialize(this); }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  prepend(...nodes) {
    const ref = this.childNodes[0] || null;
    nodes.forEach((n) => this.insertBefore(n, ref));
  }
  querySelector(sel) { return querySelectorAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return querySelectorAll(this, sel); }
  getElementsByTagName(tag) {
    const want = String(tag).toLowerCase();
    const all = want === "*" ? querySelectorAll(this, "*") : querySelectorAll(this, want);
    return all;
  }
  getElementsByClassName(cls) {
    return querySelectorAll(this, "." + String(cls).trim().split(/\s+/).join("."));
  }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (matchesSelector(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  matches(sel) { return matchesSelector(this, sel); }
  getBoundingClientRect() {
    const cs = getComputedStyle(this);
    const w = parseFloat(this.style.width || cs.width || "") || 0;
    const h = parseFloat(this.style.height || cs.height || "") || 0;
    const left = parseFloat(this.style.left || "") || 0;
    const top = parseFloat(this.style.top || "") || 0;
    return { x: left, y: top, left, top, right: left + w, bottom: top + h, width: w, height: h };
  }
  get offsetWidth() { const r = this.getBoundingClientRect(); return r.width; }
  get offsetHeight() { const r = this.getBoundingClientRect(); return r.height; }
  get offsetParent() {
    if (!this.isConnected || this === this.ownerDocument.documentElement) return null;
    let n = this;
    while (n && n.nodeType === 1) {
      const d = getComputedStyle(n).display;
      if (d === "none") return null;
      n = n.parentNode;
    }
    return this.ownerDocument.body || this.ownerDocument.documentElement;
  }
  get disabled() { return !!this._disabled; }
  set disabled(v) { this._disabled = !!v; }
  get readOnly() { return !!this._readOnly; }
  set readOnly(v) { this._readOnly = !!v; }
  get checked() { return !!this._checked; }
  set checked(v) { this._checked = !!v; }
  get value() {
    if (this._value !== undefined) return this._value;
    const a = this.getAttribute("value");
    return a === null ? "" : a;
  }
  set value(v) { this._value = String(v); }
  get options() { return this._tag === "select" ? this.querySelectorAll("option") : undefined; }
  get selectedIndex() { return -1; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  scrollIntoView() {}
  click() {
    if (this._tag === "label") {
      const target = labelTarget(this);
      if (target) target.click();
      this.dispatchEvent(new ShimEvent("click", { bubbles: true }));
      return;
    }
    if (this._tag === "input") {
      const type = (this.getAttribute("type") || "text").toLowerCase();
      if (type === "radio") {
        const root = this.getRootNode();
        const name = this.getAttribute("name");
        if (name) for (const other of root.querySelectorAll('input[type=radio]')) {
          if (other !== this && other.getAttribute("name") === name) other._checked = false;
        }
        this._checked = true;
      } else if (type === "checkbox") {
        this._checked = !this._checked;
      }
      this.dispatchEvent(new ShimEvent("click", { bubbles: true }));
      this.dispatchEvent(new ShimEvent("input", { bubbles: true }));
      this.dispatchEvent(new ShimEvent("change", { bubbles: true }));
      return;
    }
    this.dispatchEvent(new ShimEvent("click", { bubbles: true }));
  }
}

function labelTarget(label) {
  const forId = label.getAttribute("for");
  if (forId) {
    const el = label.ownerDocument.getElementById(forId);
    if (el) return el;
  }
  const inner = label.querySelector("input, textarea, select");
  return inner || null;
}

class HTMLElement extends Element {}
class HTMLInputElement extends HTMLElement {}
class HTMLTextAreaElement extends HTMLElement {}
class HTMLSelectElement extends HTMLElement {}
class HTMLOptionElement extends HTMLElement {}

Object.defineProperty(HTMLInputElement.prototype, "value", {
  configurable: true,
  get() { if (this._value !== undefined) return this._value; const a = this.getAttribute("value"); return a === null ? "" : a; },
  set(v) { this._value = String(v); },
});
Object.defineProperty(HTMLInputElement.prototype, "checked", {
  configurable: true,
  get() { return !!this._checked; },
  set(v) { this._checked = !!v; },
});
Object.defineProperty(HTMLInputElement.prototype, "type", {
  configurable: true,
  get() { return (this.getAttribute("type") || "text").toLowerCase(); },
  set(v) { this.setAttribute("type", v); },
});
Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
  configurable: true,
  get() { if (this._value !== undefined) return this._value; return this.textContent || ""; },
  set(v) { this._value = String(v); },
});
for (const prop of ["disabled", "readOnly", "placeholder", "name", "autocomplete"]) {
  // 已经是普通属性的保持普通属性；这里只补 input/textarea 上需要的默认值语义
}

for (const r of REFLECTED) {
  if (r === "value" || r === "type") continue;
  const attr = r === "className" ? "class" : r;
  Object.defineProperty(Element.prototype, r, {
    configurable: true,
    get() { const v = this._attrs.get(attr); return v === undefined ? "" : v; },
    set(v) { this.setAttribute(attr, v == null ? "" : v); },
  });
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.nodeName = "#document";
    this.documentElement = null;
    this.head = null;
    this.body = null;
    this.title = "";
    this.activeElement = null;
    this._orderDirty = true;
    this._orderCache = null;
    this._styleCacheKey = null;
    this._styleRules = [];
    this._styleEls = null;
    this._styleElsDirty = true;
    this.defaultView = null;
    this.readyState = "complete";
  }
  createElement(tag) {
    const t = String(tag).toLowerCase();
    const C = t === "input" ? HTMLInputElement
      : t === "textarea" ? HTMLTextAreaElement
        : t === "select" ? HTMLSelectElement
          : t === "option" ? HTMLOptionElement
            : HTMLElement;
    return new C(this, t);
  }
  createTextNode(data) { return new TextNode(this, data); }
  createComment(data) { return new CommentNode(this, data); }
  createDocumentFragment() { return new HTMLElement(this, "#fragment"); }
  getElementById(id) {
    return this._walk().find((n) => n.nodeType === 1 && n.getAttribute("id") === String(id)) || null;
  }
  querySelector(sel) { return querySelectorAll(this.documentElement || this, sel)[0] || null; }
  querySelectorAll(sel) { return querySelectorAll(this.documentElement || this, sel); }
  getElementsByTagName(tag) {
    const t = String(tag).toLowerCase();
    return this._walk().filter((n) => n.nodeType === 1 && (t === "*" || n._tag === t));
  }
  createTreeWalker(root, whatToShow, filter) {
    const nodes = [];
    const accept = (n) => {
      if (whatToShow && !(whatToShow & (n.nodeType === 1 ? 1 : n.nodeType === 3 ? 4 : 0))) return false;
      if (!filter) return true;
      const fn = typeof filter === "function" ? filter : filter.acceptNode;
      const r = fn.call(filter, n);
      return r === 1; // FILTER_ACCEPT
    };
    (function walk(n) {
      for (const c of n.childNodes) {
        if (accept(c)) nodes.push(c);
        if (c.nodeType === 1) walk(c);
      }
    })(root);
    let i = -1;
    return {
      root,
      whatToShow,
      filter,
      currentNode: root,
      nextNode() { i++; if (i < nodes.length) { this.currentNode = nodes[i]; return nodes[i]; } return null; },
      previousNode() { i--; if (i >= 0) { this.currentNode = nodes[i]; return nodes[i]; } return null; },
    };
  }
  _walk() {
    const out = [];
    if (this.documentElement) (function w(n) { for (const c of n.childNodes) { out.push(c); if (c.nodeType === 1) w(c); } })(this.documentElement);
    return out;
  }
  _orderIndex() {
    if (!this._orderDirty && this._orderCache) return this._orderCache;
    const map = new Map();
    let i = 0;
    if (this.documentElement) (function w(n) { map.set(n, i++); for (const c of n.childNodes) { if (c.nodeType === 1) w(c); else map.set(c, i++); } })(this.documentElement);
    this._orderCache = map;
    this._orderDirty = false;
    return map;
  }
  addEventListener(t, f) { Node.prototype.addEventListener.call(this, t, f); }
  dispatchEvent(e) { return Node.prototype.dispatchEvent.call(this, e); }
}

function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  let s = "<" + node._tag;
  for (const [k, v] of node._attrs) s += v === "" ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`;
  s += ">";
  if (VOID_TAGS.has(node._tag)) return s;
  for (const c of node.childNodes) s += serialize(c);
  return s + `</${node._tag}>`;
}

// ---------------------------------------------------------------- HTML parser

function parseHtml(html, doc, parent) {
  const stack = [parent];
  let i = 0;
  const len = html.length;
  const appendText = (text) => {
    if (!text) return;
    stack[stack.length - 1].appendChild(doc.createTextNode(decodeEntities(text)));
  };
  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { appendText(html.slice(i)); break; }
    if (lt > i) appendText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const data = html.slice(lt + 4, end === -1 ? len : end);
      stack[stack.length - 1].appendChild(new CommentNode(doc, data));
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const name = html.slice(lt + 2, end === -1 ? len : end).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]._tag === name) { stack.length = k; break; }
      }
      i = end === -1 ? len : end + 1;
      continue;
    }
    const m = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(lt));
    if (!m) { appendText("<"); i = lt + 1; continue; }
    const tagName = m[1].toLowerCase();
    let j = lt + m[0].length;
    const attrs = [];
    let selfClosed = false;
    while (j < len) {
      while (j < len && /\s/.test(html[j])) j++;
      if (j >= len) break;
      if (html[j] === ">") { j++; break; }
      if (html[j] === "/" && html[j + 1] === ">") { selfClosed = true; j += 2; break; }
      if (html[j] === "/") { j++; continue; }
      const nameStart = j;
      while (j < len && !/[\s=>/]/.test(html[j])) j++;
      const aname = html.slice(nameStart, j);
      if (!aname) { j++; continue; }
      while (j < len && /\s/.test(html[j])) j++;
      let aval = "";
      if (html[j] === "=") {
        j++;
        while (j < len && /\s/.test(html[j])) j++;
        if (html[j] === '"' || html[j] === "'") {
          const q = html[j]; j++;
          const e = html.indexOf(q, j);
          aval = html.slice(j, e === -1 ? len : e);
          j = e === -1 ? len : e + 1;
        } else {
          const s = j;
          while (j < len && !/[\s>]/.test(html[j])) j++;
          aval = html.slice(s, j);
        }
      }
      attrs.push([aname.toLowerCase(), decodeEntities(aval)]);
    }
    const el = doc.createElement(tagName);
    for (const [k, v] of attrs) el.setAttribute(k, v);
    stack[stack.length - 1].appendChild(el);
    if (RAW_TEXT_TAGS.has(tagName) && !selfClosed && !VOID_TAGS.has(tagName)) {
      const re = new RegExp("</" + tagName + "\\s*>", "i");
      const rest = html.slice(j);
      const cm = re.exec(rest);
      const raw = cm ? rest.slice(0, cm.index) : rest;
      if (raw) el.appendChild(doc.createTextNode(raw));
      i = cm ? j + cm.index + cm[0].length : len;
      continue;
    }
    if (!VOID_TAGS.has(tagName) && !selfClosed) stack.push(el);
    i = j;
  }
}

function parseDocument(html) {
  const doc = new Document();
  parseHtml(html, doc, doc);
  const root = doc.childNodes.find((n) => n.nodeType === 1 && n._tag === "html") || null;
  doc.documentElement = root;
  if (root) {
    doc.head = root.querySelector("head");
    doc.body = root.querySelector("body");
  }
  doc._orderDirty = true;
  return doc;
}

// ---------------------------------------------------------------- selectors

function splitTop(sel, sep) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const selCache = new Map();
function parseSelectorList(sel) {
  const key = String(sel);
  if (selCache.has(key)) return selCache.get(key);
  const list = splitTop(key, ",").map(parseComplex);
  selCache.set(key, list);
  return list;
}

function parseComplex(sel) {
  const tokens = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) { tokens.push({ combinator: " ", text: cur }); cur = ""; }
      // 看后面是不是 >
      let j = i + 1;
      while (j < sel.length && /\s/.test(sel[j])) j++;
      if (sel[j] === ">") {
        tokens.push({ combinator: ">", text: ">" });
        i = j;
      }
      continue;
    }
    if (depth === 0 && ch === ">") {
      if (cur) { tokens.push({ combinator: " ", text: cur }); cur = ""; }
      tokens.push({ combinator: ">", text: ">" });
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push({ combinator: " ", text: cur });

  const parts = [];
  let pendingComb = null;
  for (const t of tokens) {
    if (t.text === ">") { pendingComb = ">"; continue; }
    parts.push({ combinator: pendingComb || (parts.length ? " " : null), compound: parseCompound(t.text) });
    pendingComb = null;
  }
  return parts;
}

function parseCompound(text) {
  const out = [];
  const re = /([#.]?[\w-]+|\*|\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)/g;
  let m;
  while ((m = re.exec(text))) {
    const t = m[1];
    if (t === "*") out.push({ type: "universal" });
    else if (t[0] === "#") out.push({ type: "id", name: t.slice(1) });
    else if (t[0] === ".") out.push({ type: "class", name: t.slice(1) });
    else if (t[0] === "[") out.push({ type: "attr", raw: t.slice(1, -1) });
    else if (t[0] === ":") out.push({ type: "pseudo", raw: t });
    else out.push({ type: "tag", name: t.toLowerCase() });
  }
  return out;
}

function matchAttr(el, raw) {
  const m = /^([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*([iIsS])?)?$/.exec(raw.trim());
  if (!m) return false;
  const [, name, op, dq, sq, bare, flag] = m;
  const actual = el.getAttribute(name);
  if (actual === null) return false;
  if (!op) return true;
  let want = dq !== undefined ? dq : sq !== undefined ? sq : bare;
  let have = actual;
  if (flag && flag.toLowerCase() === "i") { want = want.toLowerCase(); have = have.toLowerCase(); }
  switch (op) {
    case "=": return have === want;
    case "~=": return have.split(/\s+/).includes(want);
    case "^=": return want !== "" && have.startsWith(want);
    case "$=": return want !== "" && have.endsWith(want);
    case "*=": return want !== "" && have.includes(want);
    case "|=": return have === want || have.startsWith(want + "-");
    default: return false;
  }
}

function matchCompound(el, compound) {
  for (const c of compound) {
    if (c.type === "universal") continue;
    if (c.type === "tag") { if (el._tag !== c.name) return false; continue; }
    if (c.type === "id") { if (el.getAttribute("id") !== c.name) return false; continue; }
    if (c.type === "class") { if (!el.classList.contains(c.name)) return false; continue; }
    if (c.type === "attr") { if (!matchAttr(el, c.raw)) return false; continue; }
    if (c.type === "pseudo") {
      const raw = c.raw;
      if (raw === ":checked") { if (!el.checked) return false; continue; }
      if (raw === ":disabled") { if (!el.disabled) return false; continue; }
      if (raw === ":first-child") { if (el.previousElementSibling) return false; continue; }
      if (raw === ":last-child") { if (el.nextElementSibling) return false; continue; }
      if (raw.startsWith(":not(")) { if (matchesSelector(el, raw.slice(5, -1))) return false; continue; }
      continue;
    }
  }
  return true;
}

function matchComplex(el, parts) {
  let idx = parts.length - 1;
  if (!matchCompound(el, parts[idx].compound)) return false;
  let cur = el;
  idx--;
  while (idx >= 0) {
    const comb = parts[idx + 1].combinator;
    if (comb === ">") {
      cur = cur.parentNode;
      if (!cur || cur.nodeType !== 1) return false;
      if (!matchCompound(cur, parts[idx].compound)) return false;
      idx--;
    } else {
      let n = cur.parentNode;
      let found = false;
      while (n && n.nodeType === 1) {
        if (matchCompound(n, parts[idx].compound)) { found = true; cur = n; break; }
        n = n.parentNode;
      }
      if (!found) return false;
      idx--;
    }
  }
  return true;
}

function matchesSelector(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  return parseSelectorList(sel).some((parts) => matchComplex(el, parts));
}

function querySelectorAll(root, sel) {
  const list = parseSelectorList(sel);
  const out = [];
  const visit = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 1) {
        if (list.some((parts) => matchComplex(c, parts))) out.push(c);
        visit(c);
      }
    }
  };
  visit(root);
  return out;
}

// ---------------------------------------------------------------- computed style

const DEFAULT_DISPLAY = {
  html: "block", body: "block", div: "block", p: "block", h1: "block", h2: "block",
  h3: "block", h4: "block", h5: "block", h6: "block", ul: "block", ol: "block",
  li: "list-item", section: "block", article: "block", header: "block", footer: "block",
  nav: "block", aside: "block", main: "block", figure: "block", figcaption: "block",
  form: "block", fieldset: "block", pre: "block", hr: "block", address: "block",
  blockquote: "block", dl: "block", dt: "block", dd: "block", table: "table",
  thead: "table-header-group", tbody: "table-row-group", tfoot: "table-footer-group",
  tr: "table-row", td: "table-cell", th: "table-cell", caption: "table-caption",
  colgroup: "table-column-group", col: "table-column",
  span: "inline", a: "inline", b: "inline", i: "inline", em: "inline", strong: "inline",
  small: "inline", code: "inline", label: "inline", abbr: "inline", cite: "inline",
  sub: "inline", sup: "inline", u: "inline", s: "inline", mark: "inline", time: "inline",
  img: "inline", br: "inline", input: "inline-block", button: "inline-block",
  select: "inline-block", textarea: "inline-block", video: "inline-block",
  canvas: "inline-block", iframe: "inline", svg: "inline",
  script: "none", style: "none", head: "none", title: "none", meta: "none",
  link: "none", base: "none", template: "none", noscript: "none", option: "block",
  optgroup: "block", datalist: "none", param: "none", source: "none", track: "none",
};

function parseCssRules(text) {
  const rules = [];
  const clean = String(text).replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf("{", i);
    if (open === -1) break;
    let depth = 1, j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}") depth--;
      j++;
    }
    const selector = clean.slice(i, open).trim();
    const body = clean.slice(open + 1, j - 1);
    if (selector.startsWith("@")) {
      if (/^@(media|supports|layer|container)/i.test(selector)) rules.push(...parseCssRules(body));
    } else if (selector) {
      const decls = {};
      for (const part of body.split(";")) {
        const k = part.indexOf(":");
        if (k <= 0) continue;
        const prop = part.slice(0, k).trim().toLowerCase();
        let val = part.slice(k + 1).trim();
        val = val.replace(/\s*!important$/i, "");
        if (prop) decls[prop] = val;
      }
      if (Object.keys(decls).length) rules.push({ selector, decls });
    }
    i = j;
  }
  return rules;
}

// 收集文档里的 <style>。
//
// 必须缓存：getElementsByTagName 会遍历**整个文档**（练习页 2512 个元素）。
// 而 getComputedStyle 在 offsetParent 里被逐层调用，实测一次扫描触发 92954 次
// getElementsByTagName —— 2.3 亿次节点访问，这才是那三个测试"跑不完"的主因。
//
// 失效用独立的 _styleElsDirty（不用 _orderDirty）：后者会被 _orderIndex() 清掉，
// 拿它当失效标志会漏掉"清完之后又改了 style 内容"的情况。
function docStyleEls(doc) {
  if (!doc._styleElsDirty && doc._styleEls) return doc._styleEls;
  doc._styleEls = doc.documentElement ? doc.documentElement.getElementsByTagName("style") : [];
  doc._styleElsDirty = false;
  return doc._styleEls;
}

function docStyleRules(doc) {
  const styles = docStyleEls(doc);
  // 拿到 style 元素后，用**真实文本**做键（一两个元素，读取很便宜），
  // 内容一变就重解析 —— 比只比长度更可靠。
  const key = styles.map((s) => s.textContent).join("\u0000");
  if (doc._styleCacheKey === key) return doc._styleRules;
  const rules = [];
  for (const s of styles) rules.push(...parseCssRules(s.textContent));
  doc._styleCacheKey = key;
  doc._styleRules = rules;
  return rules;
}

// 「样式表命中的声明」缓存。
//
// 为什么必须缓存：offsetParent 会沿祖先链逐层调 getComputedStyle，而这里每条 CSS 规则
// 都要跑一次 matchesSelector。练习页有 2512 个元素、46 条规则，一次扫描实测触发
// 15804 次 offsetParent → 约 580 万次 matchesSelector → 单次扫描 79 秒。
// 那三个「加载真实练习页」的测试就是这样被拖到永远跑不完的（不是死循环，是慢到像死循环）。
//
// 缓存的是**样式表那一半**（只取决于 元素 + 规则集），行内样式每次现算 ——
// 这样 style.display = "" 仍然不覆盖样式表，css-cascade-test 的语义完全不变。
const styleCache = new WeakMap();

function styleDeclsFromRules(el, rules) {
  const doc = el.ownerDocument;
  let entry = styleCache.get(el);
  if (entry && entry.rules === rules && entry.doc === doc) return entry.decls;
  const decls = new Map();
  for (const r of rules) {
    if (matchesSelector(el, r.selector)) for (const [k, v] of Object.entries(r.decls)) decls.set(k, v);
  }
  styleCache.set(el, { doc, rules, decls });
  return decls;
}

function getComputedStyle(el) {
  const doc = el.ownerDocument;
  const rules = docStyleRules(doc);
  // 以样式表命中的结果为基底（带缓存），再叠加行内声明
  const decls = new Map(styleDeclsFromRules(el, rules));
  // ⚠ 只覆盖**非空**的行内值。
  // 真实浏览器里 `el.style.display = ""` 是"移除该行内声明"，样式表里的规则照常生效；
  // 台架以前会把空串当成有效覆盖值塞进 decls，于是 display:"" 被算成可见 ——
  // 这正是"测试全绿、用户屏幕上却没有按钮"的原因（CSS 里写着 .aa-runlog-wrap{display:none}）。
  // 空串等于"没有这条行内声明"→ **跳过**即可，让样式表里的值继续生效。
  // （注意用 continue 而不是 decls.delete(k)：decls 里装的是"样式表 + 行内"合并后的结果，
  //   delete 会连样式表里的那条一起删掉，反而算成浏览器默认 display。）
  for (const [k, v] of el.style._map) {
    if (v === "" || v === null || v === undefined) continue;
    decls.set(k, v);
  }
  const display = decls.get("display") || DEFAULT_DISPLAY[el._tag] || "inline";
  const visibility = decls.get("visibility") || "visible";
  const position = decls.get("position") || "static";
  return {
    display, visibility, position,
    width: decls.get("width") || "", height: decls.get("height") || "",
    color: decls.get("color") || "", overflow: decls.get("overflow") || "",
    zIndex: decls.get("z-index") || "",
    getPropertyValue(p) { return decls.get(String(p).toLowerCase()) || ""; },
    _decls: decls,
  };
}

module.exports = {
  Document, Node, Element, TextNode, HTMLElement, HTMLInputElement,
  HTMLTextAreaElement, HTMLSelectElement, HTMLOptionElement, ShimEvent,
  parseHtml, parseDocument, serialize, matchesSelector, querySelectorAll,
  getComputedStyle, parseCssRules, decodeEntities, VOID_TAGS,
};