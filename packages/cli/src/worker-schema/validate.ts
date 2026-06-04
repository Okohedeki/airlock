/**
 * worker.yaml validation — the CLI is the single validation gate (ADR-0020, C2).
 *
 * The schema (`worker.schema.json`) is the one source of truth; the Python runtime
 * loads and trusts whatever passes here. `init`, `doctor`, and `migrate` validate
 * through this module. Every Wave-2 epic extends the one schema file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

const schemaPath = fileURLToPath(new URL('./worker.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
let _validate: ValidateFunction | null = null;

function compiled(): ValidateFunction {
  if (_validate === null) _validate = ajv.compile(schema);
  return _validate;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate a parsed worker.yaml object against the schema. */
export function validateWorker(manifest: unknown): ValidationResult {
  const validate = compiled();
  const ok = validate(manifest) as boolean;
  const errors = ok
    ? []
    : (validate.errors ?? []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  return { ok, errors };
}

/** Throw with a readable message if invalid — used by the producer paths (C2). */
export function assertValidWorker(manifest: unknown): void {
  const { ok, errors } = validateWorker(manifest);
  if (!ok) {
    throw new Error(`invalid worker.yaml:\n  - ${errors.join('\n  - ')}`);
  }
}

export { schema as workerSchema };
