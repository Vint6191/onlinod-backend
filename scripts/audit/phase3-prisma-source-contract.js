"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Linter } = require("eslint");
const { Prisma } = require("@prisma/client");

const BUILTIN_VOID_FUNCTIONS = [
  "pg_sleep", "pg_sleep_for", "pg_sleep_until",
  "pg_advisory_lock", "pg_advisory_lock_shared",
  "pg_advisory_xact_lock", "pg_advisory_xact_lock_shared",
];

function filesBelow(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file, predicate) : predicate(file) ? [file] : [];
  });
}

// Include every installed migration generation: rolling proofs deliberately
// exercise old function definitions as well as the final schema. This is a
// preflight for known literal contracts, NOT a replacement for PostgreSQL proof.
function knownVoidFunctions(root) {
  const names = new Set(BUILTIN_VOID_FUNCTIONS);
  for (const file of filesBelow(path.join(root, "prisma/migrations"), (name) => name.endsWith(".sql"))) {
    const sql = fs.readFileSync(file, "utf8").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    for (const definition of sql.split(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+/i).slice(1)) {
      const header = definition.split(/\b(?:LANGUAGE|AS)\b/i)[0];
      const name = header.match(/^(?:"?\w+"?\.)?"?(\w+)"?\s*\(/);
      if (name && /\bRETURNS\s+void\b/i.test(header)) names.add(name[1].toLowerCase());
    }
  }
  return names;
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function enumContract(datamodel = Prisma.dmmf.datamodel) {
  const enums = new Map(datamodel.enums.map((entry) => [entry.name, new Set(entry.values.map((value) => value.name))]));
  return new Map(datamodel.models.map((model) => [
    model.name[0].toLowerCase() + model.name.slice(1),
    new Map(model.fields.filter((field) => field.kind === "enum").map((field) => [field.name, { name: field.type, values: enums.get(field.type) }])),
  ]));
}

function inspectSource(source, { filename = "source.js", voidFunctions = new Set(BUILTIN_VOID_FUNCTIONS), datamodel } = {}) {
  const contract = enumContract(datamodel);
  const linter = new Linter({ configType: "flat" });
  const rule = {
    meta: { type: "problem", schema: [] },
    create(context) {
      const resolve = (node, seen = new Set()) => {
        if (node?.type !== "Identifier" || seen.has(node.name)) return node;
        seen.add(node.name);
        for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
          const variable = scope.set.get(node.name);
          if (!variable) continue;
          const definition = variable.defs[0];
          // Mutable bindings and parameters cannot be proven from source alone.
          if (definition?.type === "Variable" && definition.parent?.kind === "const") return resolve(definition.node.init, seen);
          break;
        }
        return node;
      };
      const property = (node, name) => {
        const object = resolve(node);
        return object?.type === "ObjectExpression"
          ? object.properties.find((item) => item.type === "Property" && propertyName(item.key) === name)?.value
          : null;
      };
      const sqlText = (node) => {
        const value = resolve(node);
        if (value?.type === "Literal" && typeof value.value === "string") return value.value;
        if (value?.type === "TemplateLiteral") return value.quasis.map((part) => part.value.cooked || part.value.raw).join(" $parameter ");
        return "";
      };
      const checkRaw = (node, sqlNode) => {
        const sql = sqlText(sqlNode).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
        const call = sql.match(/^\s*SELECT\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/i);
        if (!call || !voidFunctions.has(call[1].toLowerCase())) return;
        // An explicit cast of the returned void to text is decodable. The
        // normal command contract is $executeRaw[Unsafe], which returns count.
        let depth = 1;
        let index = call[0].length;
        let quote = null;
        for (; index < sql.length && depth; index += 1) {
          const char = sql[index];
          if (quote) {
            if (char === quote && sql[index + 1] === quote) index += 1;
            else if (char === quote) quote = null;
          } else if (char === "'" || char === '"') quote = char;
          else if (char === "(") depth += 1;
          else if (char === ")") depth -= 1;
        }
        if (/^\s*::\s*(?:text|varchar)\b/i.test(sql.slice(index))) return;
        context.report({ node, message: `Prisma cannot deserialize PostgreSQL void from ${call[1]}(): use $executeRaw[Unsafe] for a command, or explicitly cast the result.` });
      };
      const checkData = (node, fields, delegate) => {
        const data = resolve(node);
        if (data?.type === "ArrayExpression") {
          for (const item of data.elements) checkData(item, fields, delegate);
          return;
        }
        if (data?.type !== "ObjectExpression") return;
        for (const [field, enumType] of fields) {
          let value = resolve(property(data, field));
          if (value?.type === "ObjectExpression") value = resolve(property(value, "set"));
          if (value?.type === "Literal" && typeof value.value === "string" && !enumType.values.has(value.value)) {
            context.report({ node: value, message: `Invalid Prisma ${delegate}.${field}=${JSON.stringify(value.value)}; ${enumType.name} requires ${[...enumType.values].join(" | ")}. Business roleKey is a separate contract.` });
          }
        }
      };
      return {
        CallExpression(node) {
          if (node.callee.type !== "MemberExpression") return;
          const method = propertyName(node.callee.property);
          if (["$queryRawUnsafe", "$queryRaw"].includes(method)) checkRaw(node, node.arguments[0]);
          if (!["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert"].includes(method)) return;
          const delegateNode = node.callee.object;
          if (delegateNode.type !== "MemberExpression") return;
          const delegate = propertyName(delegateNode.property);
          const fields = contract.get(delegate);
          if (!fields?.size) return;
          for (const input of method === "upsert" ? ["create", "update"] : ["data"]) checkData(property(node.arguments[0], input), fields, delegate);
        },
        TaggedTemplateExpression(node) {
          if (node.tag.type === "MemberExpression" && propertyName(node.tag.property) === "$queryRaw") checkRaw(node, node.quasi);
        },
      };
    },
  };
  return linter.verify(source, [{
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    plugins: { contracts: { rules: { prisma: rule } } },
    rules: { "contracts/prisma": "error" },
  }], { filename: path.basename(filename) }).map((message) => ({
    file: filename, line: message.line, column: message.column, message: message.message,
  }));
}

function inspectRepository(root) {
  // Unit tests deliberately contain fake clients and bad-input examples.
  // Physical fixtures, production code and executable scripts must speak the
  // actual generated Prisma schema. No pinned file list to silently go stale.
  const files = ["src", "scripts"].flatMap((dir) => filesBelow(path.join(root, dir), (file) =>
    file.endsWith(".js") && (!file.endsWith(".test.js") || file.endsWith(".integration.test.js"))));
  const voidFunctions = knownVoidFunctions(root);
  const violations = files.flatMap((file) => inspectSource(fs.readFileSync(file, "utf8"), {
    filename: path.relative(root, file), voidFunctions,
  }));
  return { ok: violations.length === 0, files: files.length, violations };
}

module.exports = { knownVoidFunctions, inspectSource, inspectRepository };
