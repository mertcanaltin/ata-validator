export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidatorOptions {
  coerceTypes?: boolean;
  removeAdditional?: boolean;
  schemas?: Record<string, object> | object[];
}

export interface StandardSchemaV1Props {
  version: 1;
  vendor: "ata-validator";
  validate(
    value: unknown
  ):
    | { value: unknown }
    | { issues: Array<{ message: string; path?: ReadonlyArray<{ key: PropertyKey }> }> };
}

export class Validator {
  constructor(schema: object | string, options?: ValidatorOptions);

  /** Add a schema to the validator */
  addSchema(schema: object): void;

  /** Validate data — returns result with errors. Applies defaults, coerceTypes, removeAdditional. */
  validate(data: unknown): ValidationResult;

  /** Fast boolean check — JS codegen, no error collection */
  isValidObject(data: unknown): boolean;

  /** Validate JSON string — simdjson fast path for large docs */
  validateJSON(jsonString: string): ValidationResult;

  /** Fast boolean check for JSON string */
  isValidJSON(jsonString: string): boolean;

  /** Validate Buffer/Uint8Array — raw NAPI fast path */
  isValid(input: Buffer | Uint8Array): boolean;

  /** Zero-copy validation with pre-padded buffer */
  isValidPrepadded(paddedBuffer: Buffer, jsonLength: number): boolean;

  /** Multi-core parallel NDJSON validation — returns boolean per line */
  isValidParallel(ndjsonBuffer: Buffer): boolean[];

  /** Multi-core parallel NDJSON count — returns number of valid items */
  countValid(ndjsonBuffer: Buffer): number;

  /** Single-thread NDJSON batch validation */
  isValidNDJSON(ndjsonBuffer: Buffer): boolean[];

  /** Standard Schema V1 interface — compatible with Fastify, tRPC, TanStack, etc. */
  readonly "~standard": StandardSchemaV1Props;
}

export function validate(
  schema: object | string,
  data: unknown
): ValidationResult;

export function version(): string;

export function createPaddedBuffer(jsonStr: string): { buffer: Buffer; length: number };

export const SIMDJSON_PADDING: number;
