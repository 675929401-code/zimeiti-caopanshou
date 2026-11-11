import { z } from 'zod'
import { isPublishingSafeHttps } from './publishing-contract'
import { isPublishingOptionValue } from './publishing-generic-contract'
const datetime = z.string().datetime({ offset: true })
const reviewedOptionPatterns = new Set([
  '^urn:li:person:[^/?#]+$',
  z.toJSONSchema(z.string().datetime()).pattern,
  z.toJSONSchema(z.string().datetime({ offset: true })).pattern,
].filter((value): value is string => typeof value === 'string'));
/** Deliberately bounded JSON Schema subset; unknown validation keywords fail closed. */
export function validatePublishingProviderOptions(schema: Record<string, unknown>, value: unknown, depth = 0): boolean {
  if (depth > 12 || !isPublishingOptionValue(value)) return false;
  const allowed = new Set(["$schema", "$id", "title", "description", "default", "examples", "type", "properties", "propertyNames", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "allOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format"]);
  if (Object.keys(schema).some(key => !allowed.has(key))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(item => typeof item !== "string"))) return false;
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) return false;
  const branches = (key: string) => Array.isArray(schema[key]) ? (schema[key] as unknown[]).map(item => typeof item === "object" && item !== null && !Array.isArray(item) && validatePublishingProviderOptions(item as Record<string, unknown>, value, depth + 1)) : null;
  const any = branches("anyOf"), one = branches("oneOf"), all = branches("allOf");
  if (any && !any.some(Boolean) || one && one.filter(Boolean).length !== 1 || all && !all.every(Boolean)) return false;
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))) return false;
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => type === actualType || type === "integer" && Number.isInteger(value))) return false;
  if (typeof value === "number" && (typeof schema.minimum === "number" && value < schema.minimum || typeof schema.maximum === "number" && value > schema.maximum)) return false;
  if (typeof value === "number" && (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum || typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum || typeof schema.multipleOf === "number" && (schema.multipleOf <= 0 || Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10))) return false;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength || typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    // Only fixed-source identity and Zod date patterns run; arbitrary remote regex is not executed.
    if (schema.pattern !== undefined && (typeof schema.pattern !== 'string' || !reviewedOptionPatterns.has(schema.pattern) || !new RegExp(schema.pattern).test(value))) return false;
    if (schema.format !== undefined && (schema.format === 'date-time' ? !datetime.safeParse(value).success : schema.format !== "uri" || !isPublishingSafeHttps(value))) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems || typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items !== undefined) {
      if (schema.items === false && value.length) return false;
      if (typeof schema.items !== "boolean" && (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items) || !value.every(item => validatePublishingProviderOptions(schema.items as Record<string, unknown>, item, depth + 1)))) return false;
    }
  } else if (actualType === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, unknown> : {};
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== "string" || !(key in object))) return false;
    for (const [key, item] of Object.entries(object)) {
      if (schema.propertyNames !== undefined && (!schema.propertyNames || typeof schema.propertyNames !== 'object' || Array.isArray(schema.propertyNames) || !validatePublishingProviderOptions(schema.propertyNames as Record<string, unknown>, key, depth + 1))) return false;
      const rule = properties[key];
      if (key in properties) {
        if (rule === false) return false;
        if (rule !== true && (!rule || typeof rule !== "object" || Array.isArray(rule) || !validatePublishingProviderOptions(rule as Record<string, unknown>, item, depth + 1))) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" && (!schema.additionalProperties || typeof schema.additionalProperties !== "object" || Array.isArray(schema.additionalProperties) || !validatePublishingProviderOptions(schema.additionalProperties as Record<string, unknown>, item, depth + 1))) return false;
    }
  }
  return true;
}
