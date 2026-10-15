"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// apps/server/src/mcp.ts
var import_mcp = require("@modelcontextprotocol/sdk/server/mcp.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_node_fs3 = require("node:fs");
var import_node_path4 = require("node:path");

// apps/server/src/motion-library-tools.ts
var import_node_path3 = require("node:path");
var import_zod = require("zod");

// references/motion-cases/skillry/tools/library-store.mjs
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// references/motion-cases/skillry/tools/mechanism-index.mjs
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_crypto = require("node:crypto");

// references/motion-cases/skillry/taxonomy.mjs
var taxonomy = {
  categories: [
    ["\u5EFA\u7ACB\u4E0E\u7D2F\u79EF", "\u9010\u9879\u51FA\u73B0\u3001\u586B\u5145\u3001\u6570\u91CF\u589E\u957F", "\u5EFA\u7ACB,\u7D2F\u79EF,\u586B\u5145,\u94FA\u6EE1,\u9646\u7EED\u51FA\u73B0,\u589E\u52A0"],
    ["\u6392\u5217\u4E0E\u91CD\u7EC4", "\u540C\u4E00\u96C6\u5408\u6362\u4F4D\u3001\u5F52\u961F\u6216\u91CD\u65B0\u6392\u5E03", "\u6392\u5217,\u91CD\u7EC4,\u5F52\u961F,\u6392\u9F50,\u91CD\u6392"],
    ["\u805A\u7126\u4E0E\u5C55\u5F00", "\u96C6\u5408\u7A81\u51FA\u4E00\u9879\u3001\u5C40\u90E8\u653E\u5927\u3001\u5185\u90E8\u5C55\u5F00", "\u805A\u7126,\u7A81\u51FA,\u6311\u51FA,\u9009\u4E2D,\u5C55\u5F00,\u653E\u5927\u7EC6\u8282"],
    ["\u8986\u76D6\u4E0E\u63ED\u793A", "\u906E\u6321\u3001\u5F00\u53E3\u3001\u5185\u5C42\u663E\u9732", "\u8986\u76D6,\u63ED\u793A,\u9732\u51FA,\u63ED\u5F00,\u906E\u6321,\u5F00\u53E3"],
    ["\u66FF\u6362\u4E0E\u63A5\u7BA1", "\u65B0\u65E7\u4EA4\u66FF\u3001\u4FDD\u6301\u53C2\u7167\u6362\u5C42", "\u66FF\u6362,\u63A5\u7BA1,\u5207\u6362,\u4EA4\u63A5,\u6362\u573A,\u8FC7\u6E21"],
    ["\u5F62\u53D8\u4E0E\u5206\u5408", "\u8F6E\u5ED3\u6539\u53D8\u3001\u5206\u88C2\u3001\u5408\u5E76", "\u5F62\u53D8,\u53D8\u5F62,\u5206\u88C2,\u5408\u5E76,\u4F38\u7F29,\u878D\u5165"],
    ["\u8DEF\u5F84\u4E0E\u8FDE\u63A5", "\u6CBF\u7EBF\u8FD0\u884C\u3001\u8FDE\u63A5\u5EFA\u7ACB\u3001\u6301\u7EED\u5F15\u5BFC", "\u8DEF\u5F84,\u8FDE\u63A5,\u8FDE\u7EBF,\u63CF\u753B,\u5F15\u5BFC,\u6CBF\u7EBF"],
    ["\u89E6\u53D1\u4E0E\u53CD\u9988", "\u63A5\u89E6\u540E\u53CD\u5E94\u3001\u7531\u63A5\u70B9\u4F20\u64AD", "\u89E6\u53D1,\u53CD\u9988,\u78B0\u649E,\u63A5\u89E6,\u6CE2\u52A8,\u6269\u6563"],
    ["\u73AF\u7ED5\u4E0E\u5F80\u590D", "\u73AF\u7ED5\u3001\u5FAA\u73AF\u3001\u6446\u52A8\u3001\u53CD\u590D\u7ECF\u8FC7", "\u73AF\u7ED5,\u5FAA\u73AF,\u5F80\u590D,\u6446\u52A8,\u8F6C\u52A8,\u6D41\u52A8"],
    ["\u56DE\u6536\u4E0E\u9000\u51FA", "\u6536\u62E2\u3001\u5F52\u4F4D\u3001\u7F29\u56DE\u3001\u9000\u573A", "\u56DE\u6536,\u9000\u51FA,\u6536\u62E2,\u5F52\u4F4D,\u7F29\u56DE,\u9000\u573A"]
  ],
  actions: [
    ["\u4F4D\u79FB", "\u79FB\u52A8,\u6ED1\u5165,\u6ED1\u51FA,\u5E73\u79FB,\u6A2A\u79FB,\u4E0A\u79FB,\u4E0B\u79FB,\u9000\u8BA9"],
    ["\u7F29\u653E", "\u653E\u5927,\u7F29\u5C0F,\u63A8\u8FD1,\u62C9\u8FDC,\u53D8\u5927,\u53D8\u5C0F"],
    ["\u65CB\u8F6C", "\u8F6C\u6B63,\u8F6C\u52A8,\u503E\u8F6C,\u7FFB\u8F6C,\u4FA7\u8F6C"],
    ["\u9519\u5F00", "\u9519\u5F00,\u4F9D\u6B21,\u9010\u9879,\u9646\u7EED,\u5206\u6279,\u4EA4\u9519"],
    ["\u663E\u9690", "\u6DE1\u5165,\u6DE1\u51FA,\u51CF\u6DE1,\u6D88\u9690,\u51FA\u73B0,\u6D88\u5931"],
    ["\u63CF\u753B", "\u5212\u7EBF,\u753B\u7EBF,\u8FDE\u7EBF,\u63CF\u8FB9,\u5EF6\u4F38"],
    ["\u586B\u5145", "\u586B\u5145,\u94FA\u6EE1,\u586B\u6EE1,\u7D2F\u79EF,\u589E\u957F"],
    ["\u906E\u6321", "\u906E\u4F4F,\u906E\u6321,\u8986\u76D6,\u76D6\u4F4F,\u63A0\u8FC7"],
    ["\u5F00\u5408", "\u6253\u5F00,\u5408\u62E2,\u5F00\u53E3,\u63ED\u5F00,\u5C55\u5F00,\u6298\u53E0"],
    ["\u5F62\u53D8", "\u5F62\u53D8,\u62C9\u4F38,\u6324\u538B,\u53D8\u5F62,\u5F2F\u66F2"],
    ["\u5206\u5408", "\u5206\u79BB,\u5206\u88C2,\u5408\u5E76,\u7EC4\u5408,\u6563\u5F00,\u6536\u62E2"],
    ["\u56DE\u5F39", "\u56DE\u8C03,\u56DE\u5F39,\u8FC7\u51B2,\u56DE\u6446,\u843D\u7A33"],
    ["\u73AF\u7ED5", "\u73AF\u7ED5,\u7ED5\u884C,\u8F68\u9053,\u516C\u8F6C"],
    ["\u66FF\u6362", "\u66FF\u6362,\u63A5\u7BA1,\u6362\u5165,\u5339\u914D,\u4EA4\u66FF"],
    ["\u7A7F\u884C", "\u7A7F\u8FC7,\u7A7F\u5165,\u7ECF\u8FC7,\u8D8A\u8FC7,\u7A7F\u884C"],
    ["\u8D77\u4F0F", "\u8D77\u4F0F,\u6446\u52A8,\u6CE2\u52A8,\u5F39\u52A8,\u6296\u52A8"],
    ["\u4F20\u64AD", "\u4F20\u64AD,\u6269\u6563,\u8FDE\u9501,\u9010\u5C42"],
    ["\u53D6\u666F\u53D8\u5316", "\u955C\u5934,\u53D6\u666F,\u63A8\u8FD1,\u62C9\u8FDC,\u8DDF\u968F,\u4FEF\u89C6"]
  ],
  states: ["\u7A7A\u533A\u57DF", "\u5355\u9879", "\u96C6\u5408", "\u7F51\u683C", "\u5916\u6846", "\u6587\u5B57\u7EC4", "\u8F6E\u5ED3", "\u8DEF\u5F84", "\u5F00\u53E3", "\u5185\u5C42", "\u524D\u666F", "\u5E73\u9762", "\u5E76\u7F6E", "\u6563\u7F6E", "\u5806\u53E0", "\u5C55\u5F00", "\u8986\u76D6"].map((x) => [x, x]),
  holds: ["\u5916\u6846\u4FDD\u6301", "\u5E95\u5C42\u4FDD\u6301", "\u4E3B\u4F53\u4FDD\u6301", "\u96C6\u5408\u4FDD\u6301", "\u53C2\u7167\u4FDD\u6301", "\u7ED3\u679C\u4FDD\u6301", "\u5185\u90E8\u8FDE\u7EED"].map((x) => [x, x]),
  anchors: ["\u4F4D\u7F6E\u63A5\u70B9", "\u8F6E\u5ED3\u63A5\u70B9", "\u65B9\u5411\u63A5\u70B9", "\u5BF9\u8C61\u5EF6\u7EED", "\u8DEF\u5F84\u63A5\u70B9", "\u5F00\u53E3\u63A5\u70B9", "\u63A5\u89E6\u70B9"].map((x) => [x, x])
};
var retrievalFields = ["categories", "actions", "entry", "exit", "holds", "anchors"];
function termsFor(field) {
  return taxonomy[field === "entry" || field === "exit" ? "states" : field].map((x) => x[0]);
}
function validateRetrieval(value, id2 = "\u673A\u5236") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${id2} \u7F3A\u5C11\u68C0\u7D22\u5206\u7C7B`);
  if (Object.keys(value).some((k) => !retrievalFields.includes(k))) throw new Error(`${id2} \u68C0\u7D22\u5206\u7C7B\u5B58\u5728\u672A\u77E5\u5B57\u6BB5`);
  for (const field of retrievalFields) {
    const values = value[field], allowed = termsFor(field);
    if (!Array.isArray(values) || values.some((v) => !allowed.includes(v)) || new Set(values).size !== values.length) throw new Error(`${id2} \u7684 ${field} \u4E0D\u5C5E\u4E8E\u7EDF\u4E00\u8BCD\u8868\u6216\u91CD\u590D`);
    if (["categories", "actions"].includes(field) && !values.length) throw new Error(`${id2} \u7684 ${field} \u4E0D\u80FD\u4E3A\u7A7A`);
  }
  return value;
}

// references/motion-cases/skillry/document-format.mjs
function splitDocument(text3) {
  const match = text3.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { metadata: null, body: text3 };
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = line.match(/^([a-z_]+):\s*(.+)$/);
    if (!entry || Object.hasOwn(metadata, entry[1])) throw new Error("\u673A\u5236\u5143\u6570\u636E\u683C\u5F0F\u9519\u8BEF\u6216\u5B57\u6BB5\u91CD\u590D");
    try {
      metadata[entry[1]] = JSON.parse(entry[2]);
    } catch {
      throw new Error("\u673A\u5236\u5143\u6570\u636E\u503C\u5FC5\u987B\u662F\u5355\u884C JSON");
    }
  }
  return { metadata, body: text3.slice(match[0].length) };
}
function parseMechanism(text3) {
  const result = splitDocument(text3), m = result.metadata;
  if (!m) throw new Error("\u673A\u5236\u6587\u6863\u7F3A\u5C11\u5143\u6570\u636E");
  for (const key2 of ["id", "title", "summary", "purpose", "relation", "start_state", "end_state"]) {
    if (typeof m[key2] !== "string" || !m[key2].trim()) throw new Error(`\u673A\u5236\u7F3A\u5C11 ${key2}`);
  }
  if (!Number.isSafeInteger(m.case_number) || m.case_number < 1) throw new Error("\u539F\u7247\u7F16\u53F7\u65E0\u6548");
  if (!new RegExp(`^${String(m.case_number).padStart(3, "0")}-m\\d{2}$`).test(m.id)) throw new Error("\u673A\u5236\u7F16\u53F7\u4E0E\u539F\u7247\u4E0D\u7B26");
  if (!Array.isArray(m.tags) || !m.tags.length || m.tags.some((t) => typeof t !== "string" || !t.trim())) throw new Error("\u673A\u5236\u6807\u7B7E\u65E0\u6548");
  validateRetrieval(m.retrieval, m.id);
  if (m.clip) {
    const c = m.clip;
    if (typeof c !== "object" || Array.isArray(c) || !Number.isSafeInteger(c.start_ms) || c.start_ms < 0 || !Number.isSafeInteger(c.end_ms) || c.end_ms <= c.start_ms || !Number.isSafeInteger(c.bytes) || c.bytes <= 0 || typeof c.path !== "string" || !/^cases\/[a-zA-Z0-9-]+\/mechanisms\/m\d{2}\.mp4$/.test(c.path) || ![c.sha256, c.source_sha256].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) || typeof c.boundary_note !== "string" || !c.boundary_note.trim()) throw new Error(`${m.id} \u5207\u7247\u5143\u6570\u636E\u65E0\u6548`);
  }
  return result;
}
function resolveLibraryLink(href, documentPath) {
  if (/^https?:\/\//i.test(href)) return { kind: "external", href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("/") || href.includes("\\")) return null;
  const root = new URL("https://reference.invalid/library/");
  const url = new URL(href, new URL(documentPath, root));
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  const path = decodeURIComponent(url.pathname.slice(root.pathname.length));
  if (path.split("/").some((p) => p === ".." || p === ".") || path.includes("\\")) return null;
  if (!/\.(md|jpg|jpeg|png|webp|mp4)$/i.test(path)) return null;
  return { kind: "local", path, hash: url.hash };
}

// references/motion-cases/skillry/selection.mjs
function validateSelection(value) {
  if (!value || value.v !== 1 || !Array.isArray(value.ids) || value.ids.length > 40 || !Array.isArray(value.adopted) || typeof value.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.source_sha256)) throw new Error("\u5019\u9009\u6E05\u5355\u683C\u5F0F\u65E0\u6548");
  if (value.ids.some((x) => typeof x !== "string" || !/^\d{3}-m\d{2}$/.test(x)) || new Set(value.ids).size !== value.ids.length) throw new Error("\u5019\u9009\u7F16\u53F7\u65E0\u6548\u6216\u91CD\u590D");
  if (value.adopted.some((x) => !value.ids.includes(x)) || new Set(value.adopted).size !== value.adopted.length) throw new Error("\u91C7\u7528\u9879\u5FC5\u987B\u5C5E\u4E8E\u5019\u9009\u6E05\u5355");
  return { v: 1, source_sha256: value.source_sha256, ids: [...value.ids], adopted: [...value.adopted] };
}
function encodeSelection(value) {
  return new URLSearchParams({ selection: JSON.stringify(validateSelection(value)) }).toString();
}
function decodeSelection(input) {
  if (typeof input !== "string" || input.length > 16e3) throw new Error("\u5019\u9009\u94FE\u63A5\u65E0\u6548\u6216\u8FC7\u957F");
  const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
  const raw = new URLSearchParams(query.split("#")[0]).get("selection");
  if (!raw) throw new Error("\u5019\u9009\u94FE\u63A5\u7F3A\u5C11\u6E05\u5355");
  return validateSelection(JSON.parse(raw));
}
function restoreSelection(input, index) {
  const value = typeof input === "string" ? decodeSelection(input) : validateSelection(input);
  const known = new Set(index.mechanisms.map((m) => m.id));
  return { ...value, unknown_ids: value.ids.filter((id2) => !known.has(id2)), stale: value.source_sha256 !== index.source_sha256 };
}

// references/motion-cases/skillry/mechanism-search.mjs
var fields = ["categories", "actions", "entry", "exit", "holds"];
var intersect = (a, b) => a.filter((x) => b.includes(x));
var unique = (a) => [...new Set(a)];
var textOf = (m) => [m.search_text ?? [m.summary, m.purpose, m.relation, m.start_state, m.end_state].join(" "), m.title, ...m.tags].join(" ").toLowerCase();
var segments = (text3) => {
  const parts = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text3)], result = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.isWordLike && part.segment.length > 1) result.push(part.segment);
    if (/^[\u3400-\u9fff]$/.test(part.segment) && /^[\u3400-\u9fff]$/.test(parts[i + 1]?.segment ?? "")) result.push(part.segment + parts[i + 1].segment);
  }
  return unique(result);
};
function understandQuery(query = "") {
  const warnings = [];
  const positive = query.toLowerCase().replace(/(?:不要|不能|不想|不许|避免|排除|别)[^，,。；;！!？?]*(?=[，,。；;！!？?]|$)/g, (clause) => {
    warnings.push(`\u9700\u6838\u5BF9\u5426\u5B9A\u6761\u4EF6\uFF1A${clause}`);
    return " ";
  });
  const concepts = {};
  for (const field of ["categories", "actions", "states", "holds", "anchors"]) concepts[field] = taxonomy[field].filter((row) => unique([row[0], ...row.at(-1).split(",")]).some((word) => positive.includes(word))).map((row) => row[0]);
  const aliases = unique(Object.entries(concepts).flatMap(([field, values]) => taxonomy[field].filter((row) => values.includes(row[0])).flatMap((row) => [row[0], ...row.at(-1).split(",")]))).sort((a, b) => b.length - a.length);
  let remainder = positive;
  for (const alias of aliases) remainder = remainder.replaceAll(alias, " ");
  return { positive, tokens: segments(remainder), concepts, warnings };
}
function connection(left, right) {
  const common2 = intersect(left.retrieval.exit, right.retrieval.entry);
  return {
    from: left.id,
    to: right.id,
    left_end: left.end_state,
    right_start: right.start_state,
    shared_states: common2,
    shared_anchors: intersect(left.retrieval.anchors, right.retrieval.anchors),
    next_holds: right.retrieval.holds,
    checks: [`\u524D\u6BB5\u7559\u4E0B\uFF1A${left.end_state}`, `\u540E\u6BB5\u8981\u6C42\uFF1A${right.start_state}`, `\u540E\u6BB5\u5173\u7CFB\uFF1A${right.relation}`],
    gap: common2.length ? "\u4EC5\u786E\u8BA4\u72B6\u6001\u7C7B\u578B\u91CD\u5408\uFF1B\u987B\u6838\u5BF9\u5BF9\u8C61\u8EAB\u4EFD\u3001\u4F4D\u7F6E\u3001\u65B9\u5411\uFF0C\u5B89\u6392\u591A\u4F59\u5C42\u9000\u8BA9\u4E0E\u7F3A\u5931\u5C42\u5EFA\u7ACB\u3002" : "\u6CA1\u6709\u5DF2\u6807\u6CE8\u7684\u5171\u540C\u8D77\u6B62\u72B6\u6001\uFF0C\u9700\u8981\u989D\u5916\u8FDE\u63A5\u6216\u66F4\u6362\u5019\u9009\u3002",
    continuous_verified: false
  };
}
function validateOptions(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("\u67E5\u8BE2\u5FC5\u987B\u4E3A\u5BF9\u8C61");
  const allowed = [...fields, "exclude_actions", "query", "stages", "similar_to", "before", "after", "ids", "selection", "offset", "limit", "source_sha256"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`\u672A\u77E5\u67E5\u8BE2\u5B57\u6BB5\uFF1A${k}`);
  for (const f of [...fields, "exclude_actions"]) if (o[f] !== void 0) {
    const values = o[f], valid = termsFor(f === "exclude_actions" ? "actions" : f);
    if (!Array.isArray(values) || values.length > 20 || values.some((v) => !valid.includes(v))) throw new Error(`\u672A\u77E5 ${f} \u6761\u4EF6\uFF1B\u8BF7\u5148\u8BFB\u53D6\u8BCD\u8868`);
  }
  if (o.query !== void 0 && (typeof o.query !== "string" || o.query.length > 1e3)) throw new Error("\u67E5\u8BE2\u6587\u5B57\u8FC7\u957F\u6216\u683C\u5F0F\u65E0\u6548");
  if (o.source_sha256 !== void 0 && (typeof o.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(o.source_sha256))) throw new Error("\u6765\u6E90\u6307\u7EB9\u683C\u5F0F\u65E0\u6548");
  const modes = ["similar_to", "before", "after", "ids", "selection", "stages"].filter((k) => o[k] !== void 0);
  if (modes.length > 1) throw new Error("\u4E00\u6B21\u67E5\u8BE2\u53EA\u80FD\u6307\u5B9A\u4E00\u79CD\u5B9A\u4F4D\u65B9\u5F0F");
  if (["ids", "selection"].some((k) => o[k] !== void 0) && ["query", ...fields, "exclude_actions", "offset", "limit"].some((k) => o[k] !== void 0)) throw new Error("\u6E05\u5355\u6216\u7F16\u53F7\u5B9A\u4F4D\u4E0D\u80FD\u6DF7\u7528\u7B5B\u9009\u548C\u5206\u9875");
  for (const f of ["similar_to", "before", "after"]) if (o[f] !== void 0 && (typeof o[f] !== "string" || !/^\d{3}-m\d{2}$/.test(o[f]))) throw new Error("\u673A\u5236\u7F16\u53F7\u683C\u5F0F\u65E0\u6548");
  if (o.ids !== void 0 && (!Array.isArray(o.ids) || !o.ids.length || o.ids.length > 40 || o.ids.some((v) => typeof v !== "string") || unique(o.ids).length !== o.ids.length)) throw new Error("\u7F16\u53F7\u5217\u8868\u65E0\u6548\u6216\u91CD\u590D");
  if (o.stages !== void 0 && (!Array.isArray(o.stages) || !o.stages.length || o.stages.length > 8 || o.stages.some((v) => typeof v !== "string" || !v.trim() || v.length > 1e3))) throw new Error("\u9636\u6BB5\u5E94\u4E3A 1\u20148 \u6BB5\u72EC\u7ACB\u7684\u8FD0\u52A8\u63CF\u8FF0");
  for (const [f, min, max] of [["offset", 0, 1e5], ["limit", 1, 50]]) if (o[f] !== void 0 && (!Number.isSafeInteger(o[f]) || o[f] < min || o[f] > max)) throw new Error("\u5206\u9875\u8303\u56F4\u65E0\u6548");
}
function queryMechanisms(index, options = {}, semantic = {}) {
  validateOptions(options);
  if (index.schema_version !== 2) throw new Error("\u7D22\u5F15\u7248\u672C\u4E0D\u652F\u6301\u68C0\u7D22\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210");
  if (options.source_sha256 && options.source_sha256 !== index.source_sha256) throw new Error("\u8D44\u6599\u5DF2\u7ECF\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u67E5\u8BE2\u5E76\u6838\u8BFB\u91C7\u7528\u9879");
  for (const m of index.mechanisms) validateRetrieval(m.retrieval, m.id);
  const byId = new Map(index.mechanisms.map((m) => [m.id, m]));
  const get = (id2) => {
    const m = byId.get(id2);
    if (!m) throw new Error(`\u672A\u77E5\u673A\u5236\uFF1A${id2}`);
    return m;
  };
  const base = {
    scope: index.scope,
    source_sha256: index.source_sha256,
    library_count: index.count,
    notice: "\u52A8\u4F5C\u5168\u6587\u53EC\u56DE\uFF1B\u5339\u914D\u5206\u6570\u4E0D\u4EE3\u8868\u89C2\u611F\u6216\u76F4\u63A5\u53EF\u8854\u63A5\u3002\u5148\u8BFB\u5019\u9009\u6307\u4EE4\u4E0E\u5206\u955C\uFF0C\u518D\u7531\u5F53\u524D\u4F5C\u8005\u51B3\u5B9A\u3002"
  };
  if (options.stages) {
    const { stages, ...rest } = options;
    return { ...base, groups: stages.map((stage) => ({ stage, ...queryMechanisms(index, { ...rest, query: stage }, semantic[stage] ? { candidates: semantic[stage] } : {}) })) };
  }
  if (options.selection) {
    const selection = restoreSelection(options.selection, index);
    return {
      ...base,
      selection,
      cards: selection.ids.filter((id2) => byId.has(id2)).map(get),
      connections: selection.ids.slice(1).map((id2, i) => byId.has(id2) && byId.has(selection.ids[i]) ? connection(get(selection.ids[i]), get(id2)) : { from: selection.ids[i], to: id2, gap: "\u672A\u77E5\u7F16\u53F7\uFF0C\u65E0\u6CD5\u6BD4\u8F83" }),
      warnings: [...selection.stale ? ["\u6E05\u5355\u6765\u6E90\u5DF2\u53D8\u5316\uFF0C\u91CD\u65B0\u6838\u8BFB\u540E\u518D\u786E\u8BA4\u91C7\u7528\u3002"] : [], ...selection.unknown_ids.map((id2) => `\u672A\u77E5\u673A\u5236\uFF1A${id2}`)]
    };
  }
  if (options.ids) {
    const cards2 = options.ids.map(get);
    return { ...base, total: cards2.length, cards: cards2, comparison: `compare.html?${encodeSelection({ v: 1, source_sha256: index.source_sha256, ids: options.ids, adopted: [] })}` };
  }
  const sourceId = options.similar_to ?? options.before ?? options.after, source = sourceId ? get(sourceId) : null;
  const intent = understandQuery(options.query);
  const hasQuery = intent.positive.trim().length > 0;
  const texts = new Map(index.mechanisms.map((m) => [m.id, textOf(m)]));
  const weights = new Map(intent.tokens.map((t) => [t, Math.log(1 + (index.mechanisms.length + 1) / (1 + [...texts.values()].filter((text3) => text3.includes(t)).length))]));
  const scored = [];
  const semanticById = new Map((semantic.candidates ?? []).map((row) => [row.id, row.score]));
  for (const m of index.mechanisms) {
    if (m.id === sourceId) continue;
    const r = m.retrieval;
    if (fields.some((f) => (options[f] ?? []).some((v) => !r[f].includes(v))) || (options.exclude_actions ?? []).some((v) => r.actions.includes(v))) continue;
    let score = 0;
    const reasons = [], text3 = texts.get(m.id);
    for (const field of fields) {
      const chosen = options[field] ?? [];
      if (chosen.length) reasons.push(`\u6EE1\u8DB3${field}\uFF1A${chosen.join("\u3001")}`);
    }
    let queryScore = 0;
    for (const f of ["categories", "actions", "holds"]) {
      const hits2 = intersect(r[f], intent.concepts[f]);
      queryScore += hits2.length * (f === "holds" ? 4 : 3);
      if (hits2.length) reasons.push(`\u8FD0\u52A8\u8BCD\u5BF9\u5E94\uFF1A${hits2.join("\u3001")}`);
    }
    const stateHits = intersect(unique([...r.entry, ...r.exit]), intent.concepts.states);
    queryScore += stateHits.length;
    const hits = intent.tokens.filter((t) => text3.includes(t));
    queryScore += hits.reduce((sum, t) => sum + weights.get(t), 0);
    if (hits.length) reasons.push(`\u63CF\u8FF0\u5BF9\u5E94\uFF1A${hits.slice(0, 8).join("\u3001")}`);
    if (hasQuery && !queryScore && !semanticById.has(m.id)) continue;
    score += queryScore;
    let difference, join2;
    if (options.similar_to) {
      let similarity = 0;
      for (const [f, w] of [["categories", 4], ["actions", 3], ["entry", 2], ["exit", 2], ["holds", 3], ["anchors", 1]]) {
        const common2 = intersect(r[f], source.retrieval[f]);
        const union = unique([...r[f], ...source.retrieval[f]]);
        similarity += union.length ? w * common2.length / union.length : 0;
      }
      score += similarity;
      reasons.push(`\u76F8\u540C\u53D8\u5316\u7C7B\uFF1A${intersect(r.categories, source.retrieval.categories).join("\u3001")}`);
      difference = { source_relation: source.relation, candidate_relation: m.relation, added_actions: r.actions.filter((v) => !source.retrieval.actions.includes(v)), absent_actions: source.retrieval.actions.filter((v) => !r.actions.includes(v)) };
    }
    if (options.after || options.before) {
      join2 = options.after ? connection(source, m) : connection(m, source);
      score += join2.shared_states.length * 3 + join2.shared_anchors.length;
      reasons.push(join2.shared_states.length ? `\u8D77\u6B62\u72B6\u6001\u53EF\u6BD4\u8F83\uFF1A${join2.shared_states.join("\u3001")}` : join2.gap);
    }
    scored.push({ ...m, score, match_reasons: unique(reasons), ...difference ? { difference } : {}, ...join2 ? { connection: join2 } : {} });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (semanticById.size) {
    const budget = 50;
    const lexical = scored.filter((card) => card.score > 0).slice(0, budget);
    const vectors = scored.filter((card) => semanticById.has(card.id)).sort((a, b) => semanticById.get(b.id) - semanticById.get(a.id) || a.id.localeCompare(b.id)).slice(0, budget);
    const lr = new Map(lexical.map((card, i) => [card.id, i + 1])), vr = new Map(vectors.map((card, i) => [card.id, i + 1]));
    for (let i = scored.length - 1; i >= 0; i--) {
      const card = scored[i], l = lr.get(card.id), v = vr.get(card.id);
      if (!l && !v) {
        scored.splice(i, 1);
        continue;
      }
      card.retrieval = { ...card.retrieval };
      card.retrieval_evidence = { lexical_rank: l, semantic_rank: v, lexical_score: card.score, semantic_score: semanticById.get(card.id) };
      card.score = (l ? 1 / (60 + l) : 0) + (v ? 1 / (60 + v) : 0);
      if (v) card.match_reasons.push(`\u52A8\u4F5C\u5173\u7CFB\u5411\u91CF\u53EC\u56DE\uFF1A\u7B2C${v}\u4F4D`);
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
  const offset2 = options.offset ?? 0, limit = options.limit ?? 12;
  if (offset2 > scored.length) throw new Error("\u5206\u9875\u8D85\u51FA\u7ED3\u679C\u8303\u56F4\uFF0C\u8BF7\u91CD\u65B0\u67E5\u8BE2");
  const cards = scored.slice(offset2, offset2 + limit), next = offset2 + cards.length;
  return {
    ...base,
    total: scored.length,
    offset: offset2,
    next_offset: next < scored.length ? next : null,
    exhausted: next >= scored.length,
    warnings: intent.warnings,
    cards,
    comparison: `compare.html?${encodeSelection({ v: 1, source_sha256: index.source_sha256, ids: cards.slice(0, 40).map((m) => m.id), adopted: [] })}`
  };
}

// references/motion-cases/skillry/tools/mechanism-index.mjs
var defaultRoot = (0, import_node_path.resolve)(process.cwd(), "references/motion-cases/skillry");
var hash = (bytes) => (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
var SEARCH_TEXT_VERSION = "motion-relations-v1";
function mechanismSearchText(metadata, body) {
  body = body.replace(/\r\n?/g, "\n");
  const sections = [...body.matchAll(/^## (运动指令|组合与调整)[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map((match) => match[2]);
  const lines = [metadata.purpose, metadata.relation, metadata.start_state, ...sections, metadata.end_state].join("\n").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return [...new Set(lines)].join("\n");
}
function localFile(root, path) {
  if (typeof path !== "string" || !path || path.includes(":") || path.includes("\\") || (0, import_node_path.isAbsolute)(path) || path.split("/").some((p) => p === ".." || p === "." || !p)) throw new Error("\u8D44\u6599\u8DEF\u5F84\u65E0\u6548");
  const file = (0, import_node_path.resolve)(root, path), rel = (0, import_node_path.relative)((0, import_node_fs.realpathSync)(root), (0, import_node_fs.realpathSync)(file));
  if (rel === ".." || rel.startsWith(".." + import_node_path.sep) || (0, import_node_path.isAbsolute)(rel)) throw new Error("\u8D44\u6599\u8DEF\u5F84\u8D8A\u754C");
  return file;
}
function buildIndex(root = defaultRoot) {
  const catalogueBytes = (0, import_node_fs.readFileSync)(localFile(root, "case-catalogue.json"));
  const catalogue = JSON.parse(catalogueBytes.toString("utf8"));
  const mechanisms = [], sources = [["catalogue", hash(catalogueBytes)], ["taxonomy", hash(JSON.stringify(taxonomy))]];
  for (const c of catalogue.cases.filter((c2) => c2.analysis_kind === "mechanisms-v1")) {
    const dir = localFile(root, c.directory + "/mechanisms");
    const files = (0, import_node_fs.readdirSync)(dir).filter((f) => f.endsWith(".md")).sort();
    if (!files.length) throw new Error(`${c.case_number} \u6CA1\u6709\u673A\u5236\u6587\u6863`);
    for (const name of files) {
      const document = c.directory + "/mechanisms/" + name;
      const bytes = (0, import_node_fs.readFileSync)(localFile(root, document));
      const { metadata: m, body } = parseMechanism(bytes.toString("utf8"));
      if (m.case_number !== c.case_number || name !== m.id.split("-")[1] + ".md") throw new Error(`${document} \u7F16\u53F7\u4E0E\u8DEF\u5F84\u4E0D\u7B26`);
      const storyboard = document.replace(/\.md$/, ".jpg");
      localFile(root, storyboard);
      if (m.clip) {
        if (m.clip.path !== document.replace(/\.md$/, ".mp4") || m.clip.source_sha256 !== c.media_sha256 || m.clip.end_ms > Math.ceil(c.duration * 1e3)) throw new Error(`${m.id} \u5207\u7247\u6765\u6E90\u3001\u8303\u56F4\u6216\u8DEF\u5F84\u4E0D\u7B26`);
        if ((0, import_node_fs.statSync)(localFile(root, m.clip.path)).size !== m.clip.bytes) throw new Error(`${m.id} \u5207\u7247\u6587\u4EF6\u4E0D\u5B8C\u6574`);
      }
      const imageLinks = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((x) => resolveLibraryLink(x[1], document));
      if (!imageLinks.some((x) => x?.kind === "local" && x.path === storyboard)) throw new Error(`${document} \u672A\u5D4C\u5165\u81EA\u8EAB\u5206\u955C`);
      sources.push([document, hash(bytes)]);
      const search_text = mechanismSearchText(m, body);
      mechanisms.push({
        ...m,
        search_text,
        search_text_version: SEARCH_TEXT_VERSION,
        text_sha256: hash(search_text),
        document,
        storyboard,
        case_slug: c.slug,
        overview: c.analysis,
        detail: `detail.html?case=${encodeURIComponent(c.slug)}&mechanism=${encodeURIComponent(m.id)}`
      });
    }
  }
  if (new Set(mechanisms.map((m) => m.id)).size !== mechanisms.length) throw new Error("\u673A\u5236\u7F16\u53F7\u91CD\u590D");
  const converted = catalogue.cases.filter((c) => c.analysis_kind === "mechanisms-v1");
  const scope = converted.length === catalogue.cases.length ? `\u5DF2\u6574\u7406 ${converted.length} / ${catalogue.cases.length} \u4E2A\u6848\u4F8B\uFF1B\u5168\u90E8\u6848\u4F8B\u5747\u5DF2\u8F6C\u6362\uFF0C\u5171 ${mechanisms.length} \u6761\u72EC\u7ACB\u673A\u5236` : `\u5DF2\u6574\u7406 ${converted.length} / ${catalogue.cases.length} \u4E2A\u6848\u4F8B\uFF08${converted.map((c) => String(c.case_number).padStart(3, "0")).join("\u3001")}\uFF09\uFF1B\u5176\u4F59 ${catalogue.cases.length - converted.length} \u4E2A\u5C1A\u672A\u8F6C\u6362`;
  return { schema_version: 2, scope, source_sha256: hash(JSON.stringify(sources)), count: mechanisms.length, mechanisms };
}
function loadIndex(root = defaultRoot) {
  const index = JSON.parse((0, import_node_fs.readFileSync)(localFile(root, "mechanism-index.json"), "utf8"));
  const actual = buildIndex(root);
  if (JSON.stringify(index) !== JSON.stringify(actual)) throw new Error("\u673A\u5236\u7D22\u5F15\u8FC7\u671F\u6216\u635F\u574F\uFF0C\u8BF7\u7EF4\u62A4\u8005\u91CD\u65B0\u751F\u6210\uFF1B\u672C\u6B21\u672A\u8FD4\u56DE\u65E7\u7ED3\u679C");
  return index;
}

// references/motion-cases/skillry/tools/library-store.mjs
function searchLibrary(root, request = {}) {
  return { ...queryMechanisms(loadIndex(root), request), taxonomy };
}
function readLibraryMechanism(root, { id: id2, part = "mechanism", source_sha256, include_storyboard = true }) {
  if (!/^\d{3}-m\d{2}$/.test(id2) || !["mechanism", "overview"].includes(part)) throw new Error("\u8D44\u6599\u7F16\u53F7\u6216\u8303\u56F4\u65E0\u6548");
  const index = loadIndex(root);
  const card = queryMechanisms(index, { ids: [id2], ...source_sha256 ? { source_sha256 } : {} }).cards[0];
  const document = part === "overview" ? card.overview : card.document;
  const storyboard = part === "overview" ? card.overview.replace(/overview\.md$/, "storyboard.jpg") : card.storyboard;
  const body = (0, import_node_fs2.readFileSync)(localFile(root, document), "utf8");
  const result = {
    card,
    source_sha256: index.source_sha256,
    part,
    document,
    body,
    preview_url: "http://127.0.0.1:8874/library/" + (part === "overview" ? `detail.html?case=${encodeURIComponent(card.case_slug)}` : card.detail),
    video_path: (0, import_node_path2.resolve)(root, card.document.split("/mechanisms/")[0], "video.mp4"),
    observation: "\u8FD4\u56DE\u539F\u673A\u5236\u6307\u4EE4\u4E0E\u9759\u6001\u5206\u955C\uFF1B\u672C\u5DE5\u5177\u6CA1\u6709\u64AD\u653E\u6216\u542C\u53D6\u89C6\u9891\u3002"
  };
  if (!include_storyboard) return { result };
  const bytes = (0, import_node_fs2.readFileSync)(localFile(root, storyboard));
  if (bytes.length > 10 * 1024 * 1024 || bytes.length < 3 || bytes.readUInt16BE(0) !== 65496) throw new Error("\u5206\u955C\u56FE\u7F3A\u5931\u3001\u8FC7\u5927\u6216\u4E0D\u662F\u6709\u6548 JPEG");
  return { result, image: bytes.toString("base64") };
}

// apps/server/src/motion-library-output.ts
var object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
var pick = (value, fields2) => {
  const source = object(value);
  return Object.fromEntries(fields2.filter((field) => source[field] !== void 0).map((field) => [field, source[field]]));
};
var list = (value, project) => Array.isArray(value) ? value.map(project) : void 0;
var connection2 = (value) => pick(value, ["from", "to", "left_end", "right_start", "shared_states", "shared_anchors", "next_holds", "checks", "gap", "continuous_verified"]);
function projectTemplateMotionSearchResult(value) {
  const source = object(value);
  const card = (entry) => pick(entry, ["id", "purpose", "relation", "start_state", "end_state", "document", "storyboard"]);
  return {
    ...pick(source, ["source_sha256", "scope", "total", "offset", "next_offset", "exhausted", "warnings", "stage"]),
    ...source.cards ? { cards: list(source.cards, card) } : {},
    ...source.groups ? { groups: list(source.groups, projectTemplateMotionSearchResult) } : {},
    ...source.connections ? { connections: list(source.connections, connection2) } : {},
    ...source.selection ? { selection: pick(source.selection, ["source_sha256", "ids", "adopted", "unknown_ids", "stale"]) } : {}
  };
}
function projectTemplateMotionMechanismResult(value) {
  const source = object(value);
  return {
    ...pick(source, ["source_sha256", "part", "document", "body", "observation"]),
    card: pick(source.card, ["id", "purpose", "relation", "start_state", "end_state", "document", "storyboard"])
  };
}

// apps/server/src/motion-library-tools.ts
var id = import_zod.z.string().regex(/^\d{3}-m\d{2}$/);
var fingerprint = import_zod.z.string().regex(/^[a-f0-9]{64}$/);
var choices = (field) => import_zod.z.array(import_zod.z.enum(termsFor(field))).max(20).optional();
function registerMotionLibraryTools(server, root = (0, import_node_path3.resolve)(process.cwd(), "references/motion-cases/skillry"), ..._removedProjectArguments) {
  const failure = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ code: "MOTION_LIBRARY_UNAVAILABLE", message: String(error), sideEffects: "none" }) }] });
  server.registerTool("search_motion_mechanisms", {
    description: "\u6309\u5B9E\u9645\u5185\u5BB9\u548C\u6F14\u51FA\u5173\u7CFB\u67E5\u8BE2\u672C\u5730\u673A\u5236\u8BCD\u6CD5\u5E93\uFF0C\u9ED8\u8BA4\u8FD4\u56DE 3 \u4E2A\u6458\u8981\uFF1B\u65E0\u5411\u91CF\u3001\u6A21\u578B\u6216\u7F51\u7EDC\u56DE\u9000\u3002",
    inputSchema: {
      query: import_zod.z.string().max(1e3).optional(),
      stages: import_zod.z.array(import_zod.z.string().min(1).max(1e3)).min(1).max(8).optional(),
      categories: choices("categories"),
      actions: choices("actions"),
      entry: choices("entry"),
      exit: choices("exit"),
      holds: choices("holds"),
      exclude_actions: choices("actions"),
      similar_to: id.optional(),
      before: id.optional(),
      after: id.optional(),
      ids: import_zod.z.array(id).min(1).max(40).optional(),
      selection: import_zod.z.string().max(16e3).optional(),
      offset: import_zod.z.number().int().min(0).optional(),
      limit: import_zod.z.number().int().min(1).max(50).optional(),
      source_sha256: fingerprint.optional()
    }
  }, async (request) => {
    try {
      const filters = [request.categories, request.actions, request.entry, request.exit, request.holds];
      if (!request.query?.trim() && !request.stages?.length && !request.ids?.length && !request.similar_to && !request.before && !request.after && !request.selection && !filters.some((values) => values?.length)) {
        throw new Error("\u8BF7\u63D0\u4F9B\u5185\u5BB9\u5173\u7CFB\u3001\u7B5B\u9009\u6761\u4EF6\u6216\u673A\u5236 ID\uFF1B\u540E\u53F0\u4E0D\u63D0\u4F9B\u5168\u5E93\u5206\u9875\u6D4F\u89C8");
      }
      const result = searchLibrary(root, { ...request, ...!request.ids && !request.selection ? { limit: request.limit ?? 3 } : {} });
      return { content: [{ type: "text", text: JSON.stringify({ ...projectTemplateMotionSearchResult(result), query: request, diagnostics: { mode: "lexical", semantic_used: false, reason: "\u4EC5\u8BCD\u6CD5\u68C0\u7D22\uFF1B\u65E0\u7ED3\u679C\u65F6\u8C03\u6574\u8BCD\u8BED\u6216\u7B5B\u9009" } }) }] };
    } catch (error) {
      return failure(error);
    }
  });
  server.registerTool("read_motion_mechanism", {
    description: "\u9ED8\u8BA4\u53EA\u8BFB\u53D6\u672C\u5730\u673A\u5236\u6B63\u6587\uFF1B\u663E\u5F0F include_storyboard=true \u624D\u9644\u9759\u6001\u5206\u955C\uFF0C\u9759\u6001\u56FE\u7247\u4E0D\u4EE3\u8868\u8FDE\u7EED\u5BA1\u7247\u3002",
    inputSchema: { id, part: import_zod.z.literal("mechanism").optional(), source_sha256: fingerprint.optional(), include_storyboard: import_zod.z.boolean().optional() }
  }, async (request) => {
    try {
      const loaded = readLibraryMechanism(root, { ...request, include_storyboard: request.include_storyboard ?? false });
      const content = [{ type: "text", text: JSON.stringify(projectTemplateMotionMechanismResult(loaded.result)) }];
      if (loaded.image) content.push({ type: "image", data: loaded.image, mimeType: "image/jpeg" });
      return { content };
    } catch (error) {
      return failure(error);
    }
  });
}

// apps/server/src/production/speech-tools.ts
var import_zod9 = require("zod");

// packages/speech-services/src/doubao.ts
var import_zod3 = require("zod");

// packages/production-service/src/contracts.ts
var import_zod2 = require("zod");
var text = import_zod2.z.string().max(1e5).refine((v) => v.trim().length > 0, "\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
var sceneId = import_zod2.z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).refine((v) => v !== "whole-video", "\u6574\u7247 ID \u4E0D\u53EF\u7528\u4E8E\u5206\u955C");
var offset = import_zod2.z.number().int().nonnegative();
var directingSchema = import_zod2.z.object({
  kind: import_zod2.z.enum(["speech", "visual"]),
  speechTurns: import_zod2.z.array(import_zod2.z.object({ id: sceneId, speakerId: import_zod2.z.string().min(1).max(80).nullable(), start: offset, end: offset }).strict()).max(500),
  visualDirections: import_zod2.z.array(import_zod2.z.string().max(8e3).refine((v) => Boolean(v.trim()), "\u753B\u9762\u8BF4\u660E\u4E0D\u80FD\u4E3A\u7A7A")).max(100),
  chapter: import_zod2.z.string().min(1).max(300).optional(),
  durationSec: import_zod2.z.number().finite().positive().max(3600).optional()
}).strict();
var sceneFields = { id: sceneId, content: import_zod2.z.string().max(1e5), submittedContent: import_zod2.z.string().max(1e5).optional(), directing: directingSchema.optional() };
function checkScene(scene, ctx) {
  const fail = (path, message) => ctx.addIssue({ code: import_zod2.z.ZodIssueCode.custom, path, message });
  const d = scene.directing;
  if (d?.kind === "visual") {
    if (scene.content.length || d.speechTurns.length || !d.visualDirections.length || !d.durationSec) fail(["directing"], "\u65E0\u53E3\u64AD\u5206\u955C\u987B\u6B63\u6587\u4E3A\u7A7A\u3001\u6CA1\u6709\u53D1\u8A00\u3001\u6709\u753B\u9762\u5B89\u6392\u53CA\u6B63\u65F6\u957F");
    return;
  }
  if (!scene.content.trim()) fail(["content"], "\u53E3\u64AD\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
  if (!d) return;
  if (d.durationSec !== void 0) fail(["directing", "durationSec"], "\u53E3\u64AD\u65F6\u957F\u987B\u6765\u81EA\u5B9E\u9645\u97F3\u9891");
  let cursor = 0;
  const ids = /* @__PURE__ */ new Set();
  for (const [i, t] of d.speechTurns.entries()) {
    if (ids.has(t.id) || t.start !== cursor || t.end <= t.start || t.end > scene.content.length) fail(["directing", "speechTurns", i], "\u53D1\u8A00 ID \u91CD\u590D\u6216 UTF-16 \u8303\u56F4\u91CD\u53E0\u3001\u9057\u6F0F\u3001\u8D8A\u754C");
    for (const p of [t.start, t.end]) if (p > 0 && p < scene.content.length && /[\uD800-\uDBFF]/u.test(scene.content[p - 1]) && /[\uDC00-\uDFFF]/u.test(scene.content[p])) fail(["directing", "speechTurns", i], "\u53D1\u8A00\u8FB9\u754C\u4E0D\u80FD\u62C6\u5F00\u5B57\u7B26");
    if (!scene.content.slice(t.start, t.end).trim()) fail(["directing", "speechTurns", i], "\u53D1\u8A00\u4E0D\u80FD\u53EA\u6709\u7A7A\u767D");
    ids.add(t.id);
    cursor = t.end;
  }
  if (cursor !== scene.content.length) fail(["directing", "speechTurns"], "\u53D1\u8A00\u5FC5\u987B\u5B8C\u6574\u8986\u76D6\u6B63\u6587");
}
var sceneSchema = import_zod2.z.object(sceneFields).strict().superRefine(checkScene);
var analysisSceneSchema = import_zod2.z.object({ id: sceneId, content: text, dur: import_zod2.z.number().finite().positive(), durationSource: import_zod2.z.literal("estimated") }).strict();
var uniqueScenes = (v) => new Set(v.map((s) => s.id)).size === v.length;
var scenes = import_zod2.z.array(sceneSchema).min(1).max(200).refine(uniqueScenes, "\u5206\u955C ID \u91CD\u590D");
var common = { taskId: import_zod2.z.string().min(1).max(200), otherRequirements: import_zod2.z.string().max(2e4) };
var analysisRequestSchema = import_zod2.z.object({ ...common, content: import_zod2.z.string().max(1e5).default(""), otherRequirements: common.otherRequirements.default(""), plugin: import_zod2.z.object({ customTemplateId: import_zod2.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict() }).strict().refine((v) => Boolean(v.content.trim() || v.otherRequirements.trim()), "\u6B63\u6587\u4E0E\u9700\u6C42\u81F3\u5C11\u4E00\u680F\u6709\u5B9E\u8D28\u5185\u5BB9");
var renderRequestSchema = import_zod2.z.object({
  ...common,
  basePlanVersion: import_zod2.z.number().int().positive(),
  dataList: scenes,
  baseRenderRunId: import_zod2.z.string().uuid().optional(),
  revisionInstructions: text.optional()
}).strict().refine((v) => Boolean(v.baseRenderRunId) === Boolean(v.revisionInstructions), "\u57FA\u7840\u6210\u7247\u548C\u4FEE\u6539\u8BF4\u660E\u5FC5\u987B\u540C\u65F6\u63D0\u4F9B");
var analysisResultSchema = import_zod2.z.object({
  taskId: import_zod2.z.string(),
  runId: import_zod2.z.string().uuid(),
  inputDigest: import_zod2.z.string(),
  dataList: import_zod2.z.array(analysisSceneSchema).min(1).max(200).refine(uniqueScenes, "\u5206\u955C ID \u91CD\u590D"),
  context: import_zod2.z.string().min(1).refine((value) => value.trim().length > 0, "context \u5FC5\u987B\u662F\u975E\u7A7A Markdown \u5B57\u7B26\u4E32")
}).strict();
var sceneCutMetadataSchema = import_zod2.z.object({
  cutMode: import_zod2.z.enum(["accurate", "stream_copy", "local_transcode"]),
  requestedStartSec: import_zod2.z.number().finite().nonnegative(),
  requestedEndSec: import_zod2.z.number().finite().positive(),
  measuredDurationSec: import_zod2.z.number().finite().positive(),
  startDeviationMs: import_zod2.z.number().finite(),
  endDeviationMs: import_zod2.z.number().finite(),
  mediaValidationVersion: import_zod2.z.literal("scene-cut-v1"),
  fallbackReason: import_zod2.z.string().max(8e3).optional(),
  boundaryValidation: import_zod2.z.enum(["packet-pts-and-decoded-boundaries", "decoded-boundaries", "accurate-frame-trim"]),
  videoToleranceMs: import_zod2.z.number().finite().nonnegative(),
  audioToleranceMs: import_zod2.z.number().finite().nonnegative()
}).strict();
var deliverySchema = import_zod2.z.object({
  taskId: import_zod2.z.string(),
  runId: import_zod2.z.string().uuid(),
  inputDigest: import_zod2.z.string(),
  templateDigest: import_zod2.z.string(),
  renderRequestId: import_zod2.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  sourceDigest: import_zod2.z.string(),
  timelineRef: import_zod2.z.string(),
  checks: import_zod2.z.array(import_zod2.z.string()),
  files: import_zod2.z.array(import_zod2.z.object({
    id: import_zod2.z.string(),
    content: import_zod2.z.string(),
    file: import_zod2.z.string(),
    sha256: import_zod2.z.string(),
    dur: import_zod2.z.number().positive(),
    fromFrame: import_zod2.z.number().int().nonnegative(),
    toFrame: import_zod2.z.number().int().positive(),
    width: import_zod2.z.number().int().positive(),
    height: import_zod2.z.number().int().positive(),
    fps: import_zod2.z.number().positive(),
    cutMetadata: sceneCutMetadataSchema.optional()
  }).strict()).min(2)
}).strict();
var finalHandoffSchema = import_zod2.z.object({ kind: import_zod2.z.literal("final"), taskId: import_zod2.z.string(), runId: import_zod2.z.string(), inputDigest: import_zod2.z.string(), resultPath: import_zod2.z.string().min(1) }).strict();
var turnResultSchema = import_zod2.z.discriminatedUnion("kind", [finalHandoffSchema, import_zod2.z.object({ kind: import_zod2.z.literal("await_runtime"), renderRequestId: import_zod2.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict()]);
var modelTurnOutputSchema = import_zod2.z.object({ result: turnResultSchema }).strict();

// packages/speech-services/src/doubao.ts
var requestKey = import_zod3.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
var speechSchema = import_zod3.z.object({ runId: import_zod3.z.string().uuid(), speechRequestId: requestKey, segmentId: import_zod3.z.string().min(1), sceneId: import_zod3.z.string().min(1).optional(), text: import_zod3.z.string().min(1).max(2e3), voiceRef: import_zod3.z.string().min(1), speed: import_zod3.z.number().int().min(-50).max(100).default(0), reuseJobId: import_zod3.z.string().uuid().optional(), reuseRunId: import_zod3.z.string().uuid().optional() }).strict();
var speechBatchSchema = import_zod3.z.object({ runId: import_zod3.z.string().uuid(), speechBatchRequestId: requestKey, segments: import_zod3.z.array(speechSchema.omit({ runId: true }).extend({ sceneId: import_zod3.z.string().min(1) })).min(1).max(1e3) }).strict();

// packages/production-service/src/sentence-audio-assembly.ts
var import_zod5 = require("zod");
var import_zod_to_json_schema = require("zod-to-json-schema");

// packages/production-service/src/template-package.ts
var yauzl = __toESM(require("yauzl"), 1);
var import_zod4 = require("zod");
var manifestSchema = import_zod4.z.object({ schemaVersion: import_zod4.z.literal(1), templateVersion: import_zod4.z.string().min(1), instructions: import_zod4.z.array(import_zod4.z.string()).min(1), analysisInstructions: import_zod4.z.array(import_zod4.z.string().min(1)).min(1).optional(), entry: import_zod4.z.string().min(1), wholeComposition: import_zod4.z.string().min(1), timelineModule: import_zod4.z.string().min(1), timelineDataRef: import_zod4.z.string().min(1).optional(), timelineContract: import_zod4.z.string().min(1).optional(), publicAssetRoot: import_zod4.z.string().min(1), width: import_zod4.z.number().int().positive(), height: import_zod4.z.number().int().positive(), fps: import_zod4.z.number().positive(), voiceRefs: import_zod4.z.array(import_zod4.z.string()).default([]), speakerBindings: import_zod4.z.record(import_zod4.z.object({ speaker: import_zod4.z.string().min(1), voiceRef: import_zod4.z.string().min(1) }).strict()).optional(), captionTimingPolicy: import_zod4.z.enum(["authored", "utterance"]).optional() }).passthrough();

// packages/production-service/src/sentence-audio-assembly.ts
var key = import_zod5.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
var frames = import_zod5.z.number().int().nonnegative();
var sentenceAssemblyPlanSchema = import_zod5.z.object({ scenes: import_zod5.z.array(import_zod5.z.object({ sceneId: import_zod5.z.string().min(1), utterances: import_zod5.z.array(import_zod5.z.object({ id: import_zod5.z.string().min(1), gapBeforeFrames: frames.optional(), captionText: import_zod5.z.string().min(1).optional() }).strict()).optional(), tailFrames: frames.optional(), captions: import_zod5.z.array(import_zod5.z.object({ utteranceId: import_zod5.z.string().min(1), text: import_zod5.z.string().min(1), startFrame: frames, endFrameExclusive: frames }).strict()).optional(), captionTiming: import_zod5.z.object({ src: import_zod5.z.string().min(1), sha256: import_zod5.z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict()).min(1), chapters: import_zod5.z.array(import_zod5.z.object({ chapterId: import_zod5.z.string().min(1), sceneIds: import_zod5.z.array(import_zod5.z.string().min(1)).min(1) }).strict()).optional() }).strict();
var sentenceAssemblyPlanJsonSchema = (0, import_zod_to_json_schema.zodToJsonSchema)(sentenceAssemblyPlanSchema, { $refStrategy: "none" });
var sentenceAssemblySchema = import_zod5.z.object({ assemblyRequestId: key, speechBatchRequestIds: import_zod5.z.array(key), planRef: import_zod5.z.string().min(1).describe("\u76F8\u5BF9 project \u7684 JSON \u8BA1\u5212\u6587\u4EF6\u3002\u5B8C\u6574\u7ED3\u6784\uFF1A" + JSON.stringify(sentenceAssemblyPlanJsonSchema)), expectedTimelineSha256: import_zod5.z.string().regex(/^[a-f0-9]{64}$/) }).strict();

// packages/production-service/src/sentence-audio.ts
var import_zod6 = require("zod");
var sentenceAuditSchema = import_zod6.z.object({ timelineRef: import_zod6.z.string().min(1), speechBatchRequestIds: import_zod6.z.array(import_zod6.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)), renderRequestId: import_zod6.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }).strict();

// apps/render-worker/src/template-renderer.ts
var import_bundler = require("@remotion/bundler");
var import_renderer = require("@remotion/renderer");
var import_pngjs = require("pngjs");
var import_zod7 = require("zod");

// packages/production-service/src/media-metrics.ts
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var import_node_crypto2 = require("node:crypto");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var processInstanceId = (0, import_node_crypto2.randomUUID)();

// apps/render-worker/src/template-renderer.ts
var renderRequestIdSchema = import_zod7.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
var rangeSchema = import_zod7.z.array(import_zod7.z.object({ id: import_zod7.z.string(), fromFrame: import_zod7.z.number().int().nonnegative(), toFrame: import_zod7.z.number().int().positive() }).strict()).min(1);
var renderBase = { renderRequestId: renderRequestIdSchema, timelineRef: import_zod7.z.string().min(1), checks: import_zod7.z.array(import_zod7.z.string()) };
var publicRenderToolSchema = import_zod7.z.union([
  import_zod7.z.object({ ...renderBase, previewOnly: import_zod7.z.literal(false).default(false) }).strict(),
  import_zod7.z.object({ ...renderBase, previewOnly: import_zod7.z.literal(true), ranges: rangeSchema, sourceDigest: import_zod7.z.string().min(1).optional() }).strict()
]);
var publicRenderToolFields = import_zod7.z.object({ ...renderBase, previewOnly: import_zod7.z.boolean().default(false).describe("false \u4E3A\u6B63\u5F0F\u5BFC\u51FA\uFF0C\u670D\u52A1\u63A8\u5BFC\u5168\u90E8\u8303\u56F4\uFF1Btrue \u4E3A\u52A8\u6001\u9884\u89C8"), ranges: rangeSchema.optional().describe("\u4EC5 previewOnly=true \u5FC5\u586B\uFF1B\u6B63\u5F0F\u5BFC\u51FA\u7981\u6B62\u4F20\u5165"), sourceDigest: import_zod7.z.string().min(1).optional().describe("\u9884\u89C8\u53EF\u7ED1\u5B9A\u5DF2\u6709\u6E90\u7801\u6458\u8981\uFF1B\u51BB\u7ED3\u540E\u4E0D\u4E00\u81F4\u4F1A\u62D2\u7EDD\uFF0C\u4E0D\u5224\u65AD\u9884\u89C8\u76EE\u7684") }).strict();
var renderToolSchema = import_zod7.z.union([
  import_zod7.z.object({ ...renderBase, runId: import_zod7.z.string().uuid(), previewOnly: import_zod7.z.literal(false).default(false) }).strict(),
  import_zod7.z.object({ ...renderBase, runId: import_zod7.z.string().uuid(), previewOnly: import_zod7.z.literal(true), ranges: rangeSchema, sourceDigest: import_zod7.z.string().min(1).optional() }).strict()
]);
var resolvedRenderSchema = import_zod7.z.object({ ...renderBase, runId: import_zod7.z.string().uuid(), ranges: rangeSchema, sourceDigest: import_zod7.z.string().min(1).optional(), previewOnly: import_zod7.z.boolean().default(false) }).strict();
var previewFramesSchema = import_zod7.z.object({ runId: import_zod7.z.string().uuid(), renderRequestId: renderRequestIdSchema, frames: import_zod7.z.array(import_zod7.z.number().int().nonnegative()).min(1).max(12).refine((v) => new Set(v).size === v.length, "\u5E27\u53F7\u4E0D\u53EF\u91CD\u590D") }).strict();

// packages/production-service/src/review-service.ts
var import_zod8 = require("zod");
var text2 = import_zod8.z.string().trim().min(1).max(4e3);
var frame = import_zod8.z.number().int().nonnegative();
var requestId = import_zod8.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
var reviewRangeSchema = import_zod8.z.object({ fromFrame: frame, toFrame: frame }).strict().refine((v) => v.toFrame > v.fromFrame, "\u6B62\u5E27\u5FC5\u987B\u5927\u4E8E\u8D77\u5E27");
var evidenceSelector = import_zod8.z.union([
  import_zod8.z.object({ renderRequestId: requestId, frame }).strict(),
  import_zod8.z.object({ renderRequestId: requestId, fileId: text2 }).strict()
]);
var checkPlan = import_zod8.z.object({ checkId: text2, purpose: text2, mode: import_zod8.z.enum(["image", "video", "audio", "audiovisual"]), evidence: import_zod8.z.array(evidenceSelector).min(1), range: reviewRangeSchema.optional() }).strict();
var prepareReviewSchema = import_zod8.z.object({
  renderRequestIds: import_zod8.z.array(requestId).min(1).max(100),
  phase: import_zod8.z.enum(["pre_export", "post_export"]),
  timelineRef: text2.optional(),
  waitMs: import_zod8.z.number().int().min(0).max(6e4).default(0),
  units: import_zod8.z.array(import_zod8.z.object({ unitId: text2, sceneIds: import_zod8.z.array(text2).min(1), checks: import_zod8.z.array(checkPlan).min(1) }).strict()).min(1),
  reuse: import_zod8.z.array(import_zod8.z.object({ sourceReviewId: import_zod8.z.string().uuid(), unitId: text2, checkId: text2, evidenceId: text2, reason: text2 }).strict()).default([])
}).strict();
var assignReviewSchema = import_zod8.z.object({ reviewId: import_zod8.z.string().uuid(), unitId: text2, reviewerAgentId: text2, assignmentRequestId: requestId, previousAssignmentToken: import_zod8.z.string().uuid().nullable().default(null), reason: text2.optional() }).strict();
var readReviewSchema = import_zod8.z.object({ reviewId: import_zod8.z.string().uuid(), afterDigest: import_zod8.z.string().regex(/^[a-f0-9]{64}$/).optional(), waitMs: import_zod8.z.number().int().min(0).max(6e4).default(0) }).strict();
var submitReviewSchema = import_zod8.z.object({ reviewId: import_zod8.z.string().uuid(), assignmentToken: import_zod8.z.string().uuid(), observations: import_zod8.z.array(import_zod8.z.object({ checkId: text2, evidenceId: text2, note: text2, range: reviewRangeSchema.optional() }).strict()).max(1e3), issues: import_zod8.z.array(import_zod8.z.object({ checkId: text2, evidenceId: text2, severity: import_zod8.z.enum(["blocking", "warning", "suggestion"]), problem: text2, range: reviewRangeSchema.optional() }).strict()).max(1e3), issueResolutions: import_zod8.z.array(import_zod8.z.object({ issueId: text2, evidenceId: text2.optional(), checkId: text2.optional(), resolution: import_zod8.z.enum(["resolved", "retained"]), note: text2 }).strict()).max(1e3).optional(), status: import_zod8.z.enum(["partial", "complete"]) }).strict();

// apps/server/src/production/speech-tools.ts
function registerProductionTools(server, call, stage = "render") {
  const register = (name, description, schema) => server.registerTool(name, { description, inputSchema: schema }, async (input) => {
    try {
      const result = await call(name, name === "render_template" ? publicRenderToolSchema.parse(input) : input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result && typeof result === "object" ? result : { result } };
    } catch (e) {
      const result = { code: e.code ?? "TOOL_FAILED", reason: e.message ?? String(e), ...e.fields ? { fields: e.fields } : {}, nextStep: e.nextStep ?? "\u6838\u5BF9\u5F53\u524D\u53C2\u6570\u548C\u539F\u4EFB\u52A1\u72B6\u6001\uFF0C\u4FDD\u7559\u5DF2\u7ECF\u89C2\u5BDF\u7684\u6750\u6599" };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
  });
  register("read_production_task", "\u8BFB\u53D6\u7ED1\u5B9A\u7684\u771F\u5B9E\u4EFB\u52A1\u3001\u9636\u6BB5\u548C\u5FC5\u8981\u6A21\u677F\u4F9D\u636E\uFF1B\u5B8C\u6574\u8F93\u5165\u6CBF\u672C Run \u7684 input.json \u8BFB\u53D6\u3002", {});
  if (stage === "analysis") return;
  register("prepare_review", "\u767B\u8BB0\u4E3B\u534F\u8C03\u6307\u5B9A\u7684\u68C0\u67E5\u5355\u5143\u3001\u76EE\u7684\u548C\u539F\u5A92\u4F53\u8BC1\u636E\uFF1B\u4E0D\u542F\u52A8\u6A21\u578B\u3001\u4E0D\u81EA\u52A8\u590D\u7528\u5224\u65AD\uFF0C\u8D85\u65F6\u6CBF\u539F\u53C2\u6570\u7EED\u67E5\u3002", prepareReviewSchema.shape);
  register("assign_review_work", "\u4E3B\u534F\u8C03\u767B\u8BB0\u5DF2\u771F\u5B9E\u521B\u5EFA\u7684\u539F\u751F\u5BA1\u7247\u5B50\u4EE3\u7406\u53CA\u6307\u5B9A\u5355\u5143\uFF1B\u63A5\u66FF\u9700\u539F\u5206\u6D3E\u4EE4\u724C\uFF0C\u4E0D\u521B\u5EFA\u4EE3\u7406\u3001\u4E0D\u81EA\u52A8\u7EED\u9886\u3002", assignReviewSchema.shape);
  register("submit_review", "\u4E3B\u534F\u8C03\u4FDD\u5B58\u5BA1\u7247\u8005\u56DE\u4F20\u7684\u771F\u5B9E\u89C2\u5BDF\u548C\u95EE\u9898\uFF1Bpartial \u7D2F\u79EF\uFF0C\u5B8C\u6210\u4E0D\u81EA\u52A8\u5206\u6D3E\u4E0B\u4E00\u5305\u3002", submitReviewSchema.shape);
  register("read_review", "\u8BFB\u53D6\u8BA1\u5212\u5269\u4F59\u6570\u91CF\u3001\u95EE\u9898\u548C\u5F02\u5E38\uFF1B\u9996\u6B21\u7ACB\u5373\u8FD4\u56DE\uFF0C\u4E4B\u540E afterDigest/waitMs \u6709\u754C\u7B49\u5F85\u65B0\u72B6\u6001\uFF0C\u8D85\u65F6\u4E0D\u91CD\u5EFA\u3002", readReviewSchema.shape);
  register("synthesize_speech", "\u5F53\u524D Render \u7684\u8C46\u5305\u4E91\u7AEF\u914D\u97F3\uFF1B\u5148\u6301\u4E45\u5316\u540E\u5F02\u6B65\u6267\u884C\u3002\u540C\u952E\u540C\u8F93\u5165\u8BFB\u539F\u4EFB\u52A1\uFF0Cunknown \u4E0D\u5F97\u91CD\u65B0\u6536\u8D39\u8BF7\u6C42\u3002", speechSchema.omit({ runId: true }).shape);
  register("synthesize_speech_batch", "\u4E00\u6B21\u767B\u8BB0\u672C run \u7684\u6574\u6279\u53E5\u6BB5\uFF0C\u670D\u52A1\u6309\u89C6\u9891\u8F6E\u6D41\u6D3E\u53D1\uFF1B\u540C\u6279\u6B21\u540C\u8F93\u5165\u8FD4\u56DE\u539F\u4EFB\u52A1\uFF0C\u4E0D\u91CD\u590D\u6536\u8D39\u3002", speechBatchSchema.omit({ runId: true }).shape);
  register("read_speech_batch", "\u9ED8\u8BA4\u8FD4\u56DE\u914D\u97F3\u6279\u6B21\u8BA1\u6570\u3001\u5F02\u5E38\u4E0E\u5B8C\u6574\u97F3\u9891\u6E05\u5355\u5F15\u7528\uFF1B\u9700\u8981\u5177\u4F53\u53E5\u6BB5\u65F6\u53EF\u8BF7\u6C42\u8BE6\u60C5\uFF0C\u672A\u77E5\u7ED3\u679C\u4E0D\u5F97\u91CD\u53D1\u3002", { speechBatchRequestId: import_zod9.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), details: import_zod9.z.boolean().default(false) });
  register("retry_speech_validation", "\u4EC5\u6062\u590D\u5DF2\u7ECF\u53D6\u5F97\u97F3\u9891\u7684\u672C\u5730\u68C0\u67E5\uFF0C\u4E0D\u8BF7\u6C42\u4F9B\u5E94\u5546\u91CD\u65B0\u751F\u6210\u3002", { speechJobId: import_zod9.z.string().uuid() });
  register("assemble_sentence_audio", "\u6309\u4F5C\u8005\u505C\u987F\u3001\u5B57\u5E55\u53CA\u7AE0\u8282\u8BA1\u5212\u63A5\u56DE\u6210\u529F\u914D\u97F3\u6279\u6B21\uFF0C\u539F\u5B50\u5199\u5165\u6A21\u677F\u552F\u4E00 JSON \u65F6\u95F4\u7EBF\uFF1B\u4FDD\u7559\u89C6\u89C9\u4E0E\u6DF7\u97F3\u8BBE\u8BA1\uFF0C\u539F\u952E\u91CD\u8BD5\u53EA\u8FD4\u56DE\u539F\u8BB0\u5F55\u3002", sentenceAssemblySchema.shape);
  register("verify_sentence_audio", "\u56FA\u5B9A\u6838\u5BF9\u5F53\u524D\u786E\u8BA4\u6B63\u6587\u3001\u6279\u6B21\u97F3\u9891\u3001\u5B57\u5E55\u548C PCM \u5B9E\u6D4B\u65F6\u957F\uFF1B\u4E0D\u6267\u884C\u6A21\u677F\u4EFB\u610F\u811A\u672C\uFF0C\u4E0D\u4EE3\u66FF\u542C\u5BA1\u3002", sentenceAuditSchema.shape);
  register("read_speech_job", "\u8BFB\u53D6\u672C run \u539F\u914D\u97F3\u4EFB\u52A1\u3001\u5B9E\u6D4B\u53E5\u6BB5\u65F6\u957F\u548C\u53D7\u7BA1\u97F3\u9891\u3002", { speechJobId: import_zod9.z.string().uuid() });
  register("render_template", "\u6309\u4F5C\u4E1A\u56FA\u5B9A\u7B56\u7565\u8F93\u51FA\uFF1A\u65B0\u4EFB\u52A1\u5E76\u884C\u7ED8\u5236\u5168\u5C40\u5206\u955C\u753B\u9762\u3001\u8FDE\u7EED\u97F3\u8F68\u5408\u6210\u6574\u7247\uFF1B\u52A8\u6001\u9884\u89C8\u7ED8\u5236\u6240\u9009\u8303\u56F4\u3002\u8FD4\u56DE\u4EFB\u52A1ID\uFF0C\u4F7F\u7528read_render_job\u6709\u754C\u7B49\u5F85\u3002", publicRenderToolFields);
  register("read_render_job", "\u8BFB\u53D6\u539F\u5A92\u4F53\u4F5C\u4E1A\u6458\u8981\uFF1BwaitMs \u6700\u591A60000\uFF0C\u643A\u5E26 afterDigest \u65F6\u4EC5\u5728\u72B6\u6001\u53D8\u5316\u6216\u8D85\u65F6\u8FD4\u56DE\u3002readyFiles/readyFrames \u4EC5\u542B\u5DF2\u6838\u9A8C\u6587\u4EF6\uFF0C\u8BE6\u60C5\u6CBF detailsRef \u8BFB\u53D6\u3002", { renderRequestId: renderRequestIdSchema, waitMs: import_zod9.z.number().int().min(0).max(6e4).default(0), afterDigest: import_zod9.z.string().optional(), details: import_zod9.z.boolean().default(false) });
  register("preview_template_frames", "\u4E00\u6B21\u767B\u8BB01\uFF5E12\u4E2A\u552F\u4E00\u5168\u5C40\u5E27\uFF0C\u5F02\u6B65\u751F\u6210\u540C\u4E00\u56FA\u5B9A\u7248\u672C\u7684\u539F\u5C3A\u5BF8\u56FE\u7247\u4E0E\u6982\u89C8\uFF1B\u7528read_render_job\u8BFB\u53D6\uFF0C\u539F\u7F16\u53F7\u4E0D\u91CD\u590D\u751F\u6210\u3002", previewFramesSchema.omit({ runId: true }).shape);
  register("retry_render_slices", "\u6062\u590D\u660E\u786E\u5931\u8D25\u7684\u539F\u5A92\u4F53\u4F5C\u4E1A\u3002\u65B0\u7B56\u7565\u6838\u9A8C\u539F\u5FEB\u7167\u4E0E\u6210\u529F\u5757\u540E\u7EED\u505A\u7F3A\u5931\u5757\u6216\u5408\u6210\uFF1B\u65E7\u7B56\u7565\u987B\u53EF\u4FE1\u6574\u7247\u3002\u672A\u77E5\u3001\u53D6\u6D88\u4F5C\u4E1A\u4E0D\u80FD\u91CD\u653E\u3002", { renderRequestId: renderRequestIdSchema });
}

// apps/server/src/mcp.ts
async function main() {
  const root = process.env.TEXTVIDEO_PLUGIN_ROOT;
  if (!root) throw new Error("\u7F3A\u5C11\u63D2\u4EF6\u53D1\u884C\u4F4D\u7F6E");
  const release = JSON.parse((0, import_node_fs3.readFileSync)((0, import_node_path4.join)(root, "runtime/dist/manifest.json"), "utf8"));
  const server = new import_mcp.McpServer({ name: "textvideo-studio", version: release.pluginVersion });
  const runtime = process.env.TEXTVIDEO_RUNTIME_URL;
  server.registerTool("read_runtime_release", { description: "\u6838\u5BF9\u5F53\u524D MCP \u4E0E\u5DF2\u542F\u52A8 Runtime \u540C\u7248\uFF0C\u4E0D\u542F\u52A8\u6267\u884C\u5668\u3002", inputSchema: {} }, async () => {
    try {
      if (!runtime) throw new Error("Runtime \u5730\u5740\u672A\u914D\u7F6E");
      const r = await fetch(`${runtime}/healthz`);
      const health = await r.json();
      if (health.releaseId !== release.releaseId) throw new Error("MCP \u4E0E Runtime Release \u4E0D\u4E00\u81F4");
      return { content: [{ type: "text", text: JSON.stringify({ ...health, mcpReleaseId: release.releaseId, aligned: true }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  const call = async (name, input) => {
    if (!runtime) throw new Error("Runtime \u672A\u914D\u7F6E\uFF1B\u8BF7\u901A\u8FC7\u670D\u52A1\u542F\u52A8\u5165\u53E3\u542F\u52A8");
    const response = await fetch(`${runtime}/internal/tools/${name}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Run-Id": process.env.TEXTVIDEO_RUN_ID ?? "", "X-Run-Token": process.env.TEXTVIDEO_RUN_TOKEN ?? "" }, body: JSON.stringify(input), signal: AbortSignal.timeout(18e4) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.msg ?? "\u5DE5\u5177\u8C03\u7528\u5931\u8D25"), { code: data.error?.code, fields: data.error?.fields, nextStep: data.error?.nextStep });
    return data;
  };
  if (process.env.TEXTVIDEO_RUN_ID && process.env.TEXTVIDEO_RUN_TOKEN) {
    const task = await call("read_production_task", {});
    if (task.stage !== "analysis" && task.stage !== "render") throw new Error("\u8FD0\u884C\u9636\u6BB5\u65E0\u6548");
    if (task.stage === "render") registerMotionLibraryTools(server, (0, import_node_path4.join)(root, "runtime/dist/motion-library"));
    registerProductionTools(server, call, task.stage);
  }
  await server.connect(new import_stdio.StdioServerTransport());
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
//# sourceMappingURL=mcp.cjs.map
