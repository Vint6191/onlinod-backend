"use strict";
const c = require("./common");
const HISTORY_PROJECTION = "crm-history-fragments-v1";
const REPLY_PROJECTION = "crm-replies-context-v1";
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

function unicodeEnd(text, end) {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1;
  return end;
}
function fitText(text, start, budget, build) {
  let low = start, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(build(unicodeEnd(text, middle))) <= budget) low = middle;
    else high = middle - 1;
  }
  const end = unicodeEnd(text, low);
  return { end, value: build(end) };
}
function historyFragment(item, offset, budget) {
  c.check(Number.isSafeInteger(offset) && offset >= 0 && offset < item.text.length
    && unicodeEnd(item.text, offset) === offset, "HISTORY_CURSOR_INVALID", 400);
  const result = fitText(item.text, offset, budget, end => ({ ...item, text: item.text.slice(offset, end),
    textPart: { policy: HISTORY_PROJECTION, offset, end, total: item.text.length, complete: end === item.text.length } }));
  c.check(result.end > offset && jsonBytes(result.value) <= budget, "HISTORY_PAGE_BUDGET_INVALID", 400);
  return result.value;
}

// Reply contexts retain complete recent messages whenever possible. If the
// newest message alone is larger than the budget, expose a labelled tail view;
// the source message is never rewritten and full analysis uses fragments.
function replyMessages(descending, budget = 5632) {
  const selected = [];
  for (const item of descending) {
    if (jsonBytes([item, ...selected]) <= budget) { selected.unshift(item); continue; }
    if (selected.length) break;
    let low = 0, high = item.text.length;
    const build = start => ({ ...item, text: item.text.slice(start), textView: {
      ...item.textView, policy: REPLY_PROJECTION, omittedPrefixChars: start, originalTextChars: item.text.length } });
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const start = unicodeEnd(item.text, mid);
      if (jsonBytes([build(start)]) <= budget) high = mid;
      else low = mid + 1;
    }
    let start = unicodeEnd(item.text, low);
    if (start < item.text.length && jsonBytes([build(start)]) > budget) start += item.text.codePointAt(start) > 0xffff ? 2 : 1;
    const view = build(start);
    c.check(jsonBytes([view]) <= budget, "CRM_REPLY_METADATA_TOO_LARGE", 413);
    selected.push(view); break;
  }
  return selected;
}

// Stable, priority-ordered projection. Limit large strings/arrays explicitly,
// and advertise omissions; never pretend this is the complete saved profile.
function boundedProjection(value, budget, requiredPaths = []) {
  const result = {};
  let omitted = 0;
  function add(target, source) {
    for (const [key, item] of Object.entries(source || {})) {
      if (item === "" || item == null || (Array.isArray(item) && !item.length)) continue;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        target[key] = {}; add(target[key], item);
        if (!Object.keys(target[key]).length) delete target[key];
      } else {
        target[key] = item;
        if (jsonBytes({ ...result, _projection: { policy: REPLY_PROJECTION, omittedFields: 9999 } }) > budget) {
          delete target[key]; omitted++;
        }
      }
    }
  }
  add(result, value);
  for (const path of requiredPaths) {
    const at = root => path.split(".").reduce((current, key) => current?.[key], root);
    const required = at(value);
    if (required != null && required !== "" && !(Array.isArray(required) && !required.length))
      c.check(c.hash(at(result)) === c.hash(required), "CRM_REPLY_CONSTRAINTS_TOO_LARGE", 413);
  }
  return { ...result, _projection: { policy: REPLY_PROJECTION, omittedFields: omitted } };
}
module.exports = { HISTORY_PROJECTION, REPLY_PROJECTION, jsonBytes, historyFragment, replyMessages, boundedProjection };
