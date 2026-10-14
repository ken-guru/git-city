/**
 * A small JSON Schema checker for the keywords the published schemas in `schema/` use. Tests use it to
 * compare a validator with its schema file, so the two cannot drift apart unnoticed. It is not a general
 * validator: an unknown keyword throws, so a schema that grows beyond this subset fails loudly.
 */

import { readFileSync } from "node:fs";

type Schema = Record<string, unknown>;

const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type", "enum", "const", "required", "properties",
  "additionalProperties", "items", "minItems", "pattern", "minLength", "maxLength", "minimum", "maximum", "oneOf", "allOf",
]);

export function loadSchema(url: URL): Schema {
  return JSON.parse(readFileSync(url, "utf8")) as Schema;
}

/** Every reason `value` fails `schema`. An empty list means the value is valid. */
export function schemaErrors(schema: Schema, value: unknown, at = "$", root: Schema = schema): string[] {
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) throw new Error(`schema-check: unsupported keyword "${key}" at ${at}`);
  }
  if (typeof schema.$ref === "string") return schemaErrors(resolveRef(root, schema.$ref), value, at, root);

  const errors: string[] = [];
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at} must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${at} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  if (typeof schema.type === "string" && !typeMatches(schema.type, value)) {
    errors.push(`${at} must be a ${schema.type}`);
    return errors; // the rest of the keywords assume the type
  }

  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at} does not match ${schema.pattern}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at} is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${at} is longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at} is below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at} needs at least ${schema.minItems} items`);
    if (isSchema(schema.items)) value.forEach((item, i) => errors.push(...schemaErrors(schema.items as Schema, item, `${at}[${i}]`, root)));
  }
  if (isPlainObject(value)) {
    const properties = (isPlainObject(schema.properties) ? schema.properties : {}) as Record<string, Schema>;
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(key in value)) errors.push(`${at} is missing "${key}"`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) errors.push(...schemaErrors(properties[key]!, item, `${at}.${key}`, root));
      else if (schema.additionalProperties === false) errors.push(`${at} has unknown key "${key}"`);
      else if (isSchema(schema.additionalProperties)) errors.push(...schemaErrors(schema.additionalProperties as Schema, item, `${at}.${key}`, root));
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) errors.push(...schemaErrors(branch as Schema, value, at, root));
  }
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter((branch) => schemaErrors(branch as Schema, value, at, root).length === 0);
    if (matching.length !== 1) errors.push(`${at} must match exactly one of its ${schema.oneOf.length} alternatives (matched ${matching.length})`);
  }
  return errors;
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`schema-check: only local references are supported, got ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) node = (node as Record<string, unknown>)[part];
  if (!isSchema(node)) throw new Error(`schema-check: ${ref} does not resolve`);
  return node as Schema;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      throw new Error(`schema-check: unsupported type ${type}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): boolean {
  return isPlainObject(value);
}

