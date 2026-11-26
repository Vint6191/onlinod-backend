"use strict";

const Busboy = require("busboy");

// This boundary accepts flat form fields only. No user-supplied name is ever
// interpreted as a path, array index or object prototype property.
const SUPPORT_FIELDS = Object.freeze(["requestId", "name", "email", "topic", "message", "os", "version"]);
const FIELD_SET = new Set(SUPPORT_FIELDS);
const SUPPORT_LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  files: 3,
  fieldBytes: 10_000,
  textBytes: 40_000,
  totalBytes: 15 * 1024 * 1024 + 128 * 1024,
  durationMs: 30_000,
});

function inputError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function createSupportMultipart(limits = SUPPORT_LIMITS) {
  return function supportMultipart(req, _res, next) {
    const type = String(req.headers["content-type"] || "");
    if (!/^multipart\/form-data\b/i.test(type)) {
      // Preserve already parsed JSON/form callers, with the same flat contract.
      const value = req.body;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return next(inputError("SUPPORT_INPUT_INVALID"));
      let textBytes = 0;
      for (const [name, text] of Object.entries(value)) {
        if (!FIELD_SET.has(name) || typeof text !== "string") return next(inputError("SUPPORT_FIELD_INVALID"));
        const bytes = Buffer.byteLength(text);
        textBytes += bytes;
        if (bytes > limits.fieldBytes || textBytes > limits.textBytes) return next(inputError("SUPPORT_FIELD_LIMIT", 413));
      }
      req.files = [];
      return next();
    }

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limits.totalBytes)
      return next(inputError("SUPPORT_BODY_LIMIT", 413));
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: {
        fieldNameSize: 64, fieldSize: limits.fieldBytes, fields: SUPPORT_FIELDS.length,
        // Busboy signals limit at equality. Read one extra byte so exactly
        // 5 MiB remains valid while an oversized file is rejected.
        fileSize: limits.fileBytes + 1, files: limits.files,
        // Busboy emits partsLimit when reaching, rather than exceeding, this
        // count. The separate field/file limits reject any eleventh part.
        parts: SUPPORT_FIELDS.length + limits.files + 1,
        headerPairs: 100,
      } });
    } catch (_) {
      return next(inputError("SUPPORT_INPUT_INVALID"));
    }

    const fields = Object.create(null), files = [], streams = new Set(), pendingBuffers = new Set();
    let settled = false, bodyBytes = 0, textBytes = 0;
    const timer = setTimeout(() => finish(inputError("SUPPORT_UPLOAD_TIMEOUT", 408)), limits.durationMs);
    timer.unref?.();
    const aborted = () => finish(inputError("SUPPORT_UPLOAD_ABORTED"));
    const requestError = () => finish(inputError("SUPPORT_UPLOAD_ABORTED"));
    const count = chunk => {
      bodyBytes += chunk.length;
      if (bodyBytes > limits.totalBytes) finish(inputError("SUPPORT_BODY_LIMIT", 413));
    };
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", count);
      req.off("aborted", aborted);
      req.off("error", requestError);
      if (error) {
        req.unpipe(parser);
        for (const buffers of pendingBuffers) buffers.length = 0;
        pendingBuffers.clear();
        files.length = 0;
        // Do not destroy a parser in the middle of its synchronous event
        // callback. Stop ownership now and release all streams on the next turn.
        queueMicrotask(() => {
          for (const stream of streams) stream.destroy();
          streams.clear();
          parser.destroy();
        });
        req.resume();
      } else {
        req.body = fields;
        req.files = files;
      }
      next(error);
    }

    parser.on("field", (name, value, info) => {
      if (settled) return;
      if (!FIELD_SET.has(name) || Object.hasOwn(fields, name) || info.nameTruncated)
        return finish(inputError("SUPPORT_FIELD_INVALID"));
      textBytes += Buffer.byteLength(value);
      if (info.valueTruncated || textBytes > limits.textBytes)
        return finish(inputError("SUPPORT_FIELD_LIMIT", 413));
      fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      streams.add(stream);
      stream.on("error", () => finish(inputError("SUPPORT_INPUT_INVALID")));
      stream.once("close", () => streams.delete(stream));
      if (settled || name !== "files" || !info.filename) {
        stream.resume();
        if (!settled) finish(inputError("SUPPORT_FIELD_INVALID"));
        return;
      }
      const chunks = [];
      pendingBuffers.add(chunks);
      let size = 0;
      stream.on("limit", () => finish(inputError("SUPPORT_FILE_LIMIT", 413)));
      stream.on("data", chunk => {
        if (settled) return;
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on("end", () => {
        if (!settled) files.push({ fieldname: name, originalname: info.filename, mimetype: info.mimeType,
          size, buffer: Buffer.concat(chunks, size) });
        chunks.length = 0;
        pendingBuffers.delete(chunks);
      });
    });
    parser.on("filesLimit", () => finish(inputError("SUPPORT_FILE_LIMIT", 413)));
    parser.on("fieldsLimit", () => finish(inputError("SUPPORT_FIELD_LIMIT", 413)));
    parser.on("partsLimit", () => finish(inputError("SUPPORT_BODY_LIMIT", 413)));
    parser.on("error", () => finish(inputError("SUPPORT_INPUT_INVALID")));
    parser.on("close", () => finish());
    req.on("data", count);
    req.once("aborted", aborted);
    req.once("error", requestError);
    req.pipe(parser);
  };
}

module.exports = { SUPPORT_FIELDS, SUPPORT_LIMITS, createSupportMultipart };
