import crypto from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function typeMatches(expected, value) {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function validateNode(schema, value, location, errors) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${location}:SCHEMA_NODE_INVALID`);
    return;
  }

  if (Object.hasOwn(schema, "const") && canonicalJson(value) !== canonicalJson(schema.const)) {
    errors.push(`${location}:CONST_MISMATCH`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(value))) {
    errors.push(`${location}:ENUM_MISMATCH`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${location}:TYPE_MISMATCH`);
      return;
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${location}:MIN_LENGTH`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${location}:MAX_LENGTH`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${location}:PATTERN_MISMATCH`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${location}:MINIMUM`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${location}:MAXIMUM`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${location}:MIN_ITEMS`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${location}:MAX_ITEMS`);
    if (schema.uniqueItems === true) {
      const serialized = value.map(canonicalJson);
      if (new Set(serialized).size !== serialized.length) errors.push(`${location}:UNIQUE_ITEMS`);
    }
    if (schema.items) value.forEach((entry, index) => validateNode(schema.items, entry, `${location}[${index}]`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) errors.push(`${location}.${key}:REQUIRED`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${location}.${key}:ADDITIONAL_PROPERTY`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(childSchema, value[key], `${location}.${key}`, errors);
    }
  }
}

export function validateJsonSchema(schema, value) {
  const errors = [];
  validateNode(schema, value, "$", errors);
  return errors;
}

export function assertJsonSchema(schema, value, code = "JSON_SCHEMA_VALIDATION_FAILED") {
  const errors = validateJsonSchema(schema, value);
  if (errors.length > 0) throw new Error(`${code}:${errors[0]}`);
}
