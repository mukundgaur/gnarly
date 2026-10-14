import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './model.ts';

type ValidateFn = ((data: unknown) => boolean) & { errors?: { instancePath?: string; message?: string }[] | null };

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as new (options: object) => {
  compile: (schema: object) => ValidateFn;
};
const addFormats = require('ajv-formats') as (ajv: object) => void;

const schemaDir = process.env.GNARLY_SCHEMA_DIR
  ?? fileURLToPath(new URL('../../shared/', import.meta.url));

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(schemaDir, name), 'utf8')) as object;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validators: Record<string, ValidateFn> = {
  'building.json': ajv.compile(loadSchema('building.schema.json')),
  'scan-features.json': ajv.compile(loadSchema('scan-features.schema.json')),
  'zone-connections.json': ajv.compile(loadSchema('zone-connections.schema.json')),
  'building-layout.json': ajv.compile(loadSchema('building-layout.schema.json')),
  'surface-colors.json': ajv.compile(loadSchema('surface-colors.schema.json')),
};

function schemaErrors(validate: ValidateFn): string {
  return (validate.errors ?? []).slice(0, 8).map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

function parseJson(name: string, bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_package', `${name} is not JSON.`);
  }
}

function requireObject(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_package', `${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** Checks one uploaded object against its schema, zone id, and file signature. */
export function validatePackageObject(name: string, bytes: Buffer, zoneId: string) {
  if (name === 'structure.usdz') {
    const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
    if (!zip) throw new ApiError(400, 'invalid_package', 'structure.usdz is not a zip archive.');
    return;
  }
  if (name === 'worldmap.bin') return;
  if (name === 'surface-colors.jpg') {
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!jpeg) throw new ApiError(400, 'invalid_package', 'surface-colors.jpg is not a JPEG.');
    return;
  }
  if (name === 'scan.json') {
    requireObject(name, parseJson(name, bytes));
    return;
  }

  const validate = validators[name];
  if (!validate) throw new ApiError(400, 'invalid_file', `No schema is configured for ${name}.`);
  const value = requireObject(name, parseJson(name, bytes));
  if (!validate(value)) {
    throw new ApiError(400, 'invalid_package', `${name} does not match its schema: ${schemaErrors(validate)}`);
  }
  if ((name === 'building.json' || name === 'scan-features.json' || name === 'surface-colors.json') && value.zoneId !== zoneId) {
    throw new ApiError(400, 'invalid_package', `${name} zoneId must be ${zoneId}.`);
  }
  if (name === 'surface-colors.json' && value.atlas !== 'surface-colors.jpg') {
    throw new ApiError(400, 'invalid_package', 'surface-colors.json atlas must be surface-colors.jpg.');
  }
}
