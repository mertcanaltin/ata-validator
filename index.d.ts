export interface ValidationError {
  keyword: string;
  instancePath: string;
  schemaPath: string;
  params: Record<string, unknown>;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidateAndParseResult {
  valid: boolean;
  value: unknown;
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

export interface StandaloneModule {
  boolFn: (data: unknown) => boolean;
  hybridFactory: (validResult: object, errFn: Function) => (data: unknown) => ValidationResult;
  errFn: ((data: unknown, allErrors?: boolean) => ValidationResult) | null;
}

export class Validator {
  constructor(schema: object | string, options?: ValidatorOptions);

  /** Add a schema to the registry for cross-schema $ref resolution */
  addSchema(schema: object): void;

  /** Validate data, returns result with errors. Applies defaults, coerceTypes, removeAdditional. */
  validate(data: unknown): ValidationResult;

  /** Fast boolean check via JS codegen or tier 0 interpreter. No error collection. */
  isValidObject(data: unknown): boolean;

  /** Validate a JSON string. Uses simdjson fast path for large documents. */
  validateJSON(jsonString: string): ValidationResult;

  /** Fast boolean check for a JSON string */
  isValidJSON(jsonString: string): boolean;

  /** Parse JSON with simdjson + validate against schema. Returns parsed value and validation result. Requires native addon. */
  validateAndParse(jsonString: string | Buffer): ValidateAndParseResult;

  /** Ultra-fast buffer validation via native addon */
  isValid(input: Buffer | Uint8Array | string): boolean;

  /** Count valid documents in an NDJSON buffer. Requires native addon. */
  countValid(ndjsonBuf: Buffer | Uint8Array | string): number;

  /** Validate an array of buffers, returns count of valid ones. Requires native addon. */
  batchIsValid(buffers: (Buffer | Uint8Array)[]): number;

  /** Zero-copy validation with pre-padded buffer. Requires native addon. */
  isValidPrepadded(paddedBuffer: Buffer, jsonLength: number): boolean;

  /** Multi-core parallel NDJSON validation. Returns boolean per line. Requires native addon. */
  isValidParallel(ndjsonBuffer: Buffer): boolean[];

  /** Single-thread NDJSON batch validation. Requires native addon. */
  isValidNDJSON(ndjsonBuffer: Buffer): boolean[];

  /** Generate a standalone JS module string for zero-compile loading. Returns null if schema can't be standalone-compiled. */
  toStandalone(): string | null;

  /** Load a pre-compiled standalone module. Zero schema compilation at startup. */
  static fromStandalone(mod: StandaloneModule, schema: object | string, options?: ValidatorOptions): Validator;

  /** Bundle multiple schemas into a single JS module string. Load with Validator.loadBundle(). */
  static bundle(schemas: object[], options?: ValidatorOptions): string;

  /** Bundle multiple schemas into a self-contained JS module. No ata-validator import needed at runtime. */
  static bundleStandalone(schemas: object[], options?: ValidatorOptions): string;

  /** Bundle multiple schemas with deduplicated shared templates. Smaller output than bundle(). */
  static bundleCompact(schemas: object[], options?: ValidatorOptions): string;

  /** Load a bundle created by Validator.bundle(). Returns array of Validator instances. */
  static loadBundle(mods: object[], schemas: object[], options?: ValidatorOptions): Validator[];

  /** Standard Schema V1 interface, compatible with Fastify, tRPC, TanStack, etc. */
  readonly "~standard": StandardSchemaV1Props;
}

/** One-shot validate: creates a Validator, validates data, returns result. */
export function validate(
  schema: object | string,
  data: unknown
): ValidationResult;

/** Fast compile: returns a validate function directly. WeakMap cached, second call with same schema is near-zero cost. */
export function compile(
  schema: object | string,
  options?: ValidatorOptions
): (data: unknown) => ValidationResult;

/** Parse JSON using simdjson (native addon) or JSON.parse (fallback). */
export function parseJSON(jsonString: string | Buffer): unknown;

/** Returns ata-validator version string. */
export function version(): string;

/** Create a simdjson-compatible padded buffer from a JSON string. */
export function createPaddedBuffer(jsonStr: string): { buffer: Buffer; length: number };

/** Required padding size for simdjson buffers. */
export const SIMDJSON_PADDING: number;
