import { describe, expect, it } from 'vitest';

import { compileCodexOutputSchema } from '../src/output-schema-codec.js';

describe('Codex portable output schema compiler', () => {
  it('compiles optional nested fields into required nullable wire fields', () => {
    const schema = {
      type: 'object',
      description: 'Research result',
      properties: {
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              why: {
                type: 'string',
                description: 'Optional rationale',
                enum: ['primary', 'secondary'],
              },
              score: {
                type: 'number',
                minimum: 0,
                maximum: 100,
              },
            },
            required: ['title', 'score'],
            additionalProperties: false,
          },
        },
      },
      required: ['sources'],
      additionalProperties: false,
    };
    const original = structuredClone(schema);

    const codec = compileCodexOutputSchema(schema);

    expect(schema).toEqual(original);
    expect(codec.wireSchema).toEqual({
      type: 'object',
      description: 'Research result',
      properties: {
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              score: {
                type: 'number',
                minimum: 0,
                maximum: 100,
              },
              title: { type: 'string' },
              why: {
                type: ['string', 'null'],
                description: 'Optional rationale',
                enum: ['primary', 'secondary', null],
              },
            },
            required: ['score', 'title', 'why'],
            additionalProperties: false,
          },
        },
      },
      required: ['sources'],
      additionalProperties: false,
    });
  });

  it('restores optional placeholders recursively while retaining required nullable null', () => {
    const codec = compileCodexOutputSchema({
      type: 'object',
      properties: {
        note: { type: ['string', 'null'] },
        profile: {
          type: 'object',
          properties: {
            nickname: { type: 'string' },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  detail: { type: 'string' },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
          },
          required: ['tags'],
          additionalProperties: false,
        },
        optionalObject: {
          type: 'object',
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        },
        nullableObject: {
          type: ['object', 'null'],
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        },
      },
      required: ['note', 'nullableObject', 'profile'],
      additionalProperties: false,
    });

    expect(JSON.parse(codec.restore(JSON.stringify({
      note: null,
      profile: {
        nickname: null,
        tags: [
          { label: 'one', detail: null },
          { label: 'two', detail: 'kept' },
        ],
      },
      optionalObject: null,
      nullableObject: null,
    })))).toEqual({
      note: null,
      nullableObject: null,
      profile: {
        tags: [
          { label: 'one' },
          { label: 'two', detail: 'kept' },
        ],
      },
    });
  });

  it('canonicalizes equivalent schemas and includes the restoration plan', () => {
    const optional = compileCodexOutputSchema({
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    });
    const equivalentOptional = compileCodexOutputSchema({
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: [],
      type: 'object',
    });
    const requiredNullable = compileCodexOutputSchema({
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      required: ['value'],
      additionalProperties: false,
    });

    expect(equivalentOptional.fingerprint).toBe(optional.fingerprint);
    expect(requiredNullable.wireSchema).toEqual(optional.wireSchema);
    expect(requiredNullable.fingerprint).not.toBe(optional.fingerprint);
  });

  it('preserves a required null-only field without constructing a duplicate union', () => {
    const codec = compileCodexOutputSchema({
      type: 'object',
      properties: { empty: { type: 'null', enum: [null] } },
      required: ['empty'],
      additionalProperties: false,
    });

    expect(codec.wireSchema).toEqual({
      type: 'object',
      properties: { empty: { type: 'null', enum: [null] } },
      required: ['empty'],
      additionalProperties: false,
    });
    expect(JSON.parse(codec.restore('{"empty":null}'))).toEqual({ empty: null });
  });

  it.each([
    [
      { type: 'array', items: { type: 'string' } },
      '$.type',
      'root schema must have type "object"',
    ],
    [
      { type: ['object', 'null'], properties: {}, additionalProperties: false },
      '$.type',
      'root schema must have type "object"',
    ],
    [
      {
        type: 'object',
        properties: { value: { type: ['string', 'number'] } },
        additionalProperties: false,
      },
      '$.properties.value.type',
      'only nullable [T, "null"] unions are supported',
    ],
    [
      {
        type: 'object',
        properties: { value: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
      '$.properties.value',
      'optional property already accepts null',
    ],
    [
      {
        type: 'object',
        properties: {
          rows: { type: 'array', items: [{ type: 'string' }] },
        },
        required: ['rows'],
        additionalProperties: false,
      },
      '$.properties.rows.items',
      'tuple arrays are not supported',
    ],
    [
      {
        type: 'object',
        properties: {
          nested: { type: 'object', properties: {} },
        },
        required: ['nested'],
        additionalProperties: false,
      },
      '$.properties.nested.additionalProperties',
      'object schemas must set additionalProperties to false',
    ],
    [
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
        oneOf: [],
      },
      '$.oneOf',
      'unsupported keyword "oneOf"',
    ],
    [
      {
        type: 'object',
        properties: { value: { description: 'missing type' } },
        additionalProperties: false,
      },
      '$.properties.value.type',
      'type must be one supported type or [T, "null"]',
    ],
    [
      {
        type: 'object',
        properties: { value: { type: 'string', enum: [1] } },
        required: ['value'],
        additionalProperties: false,
      },
      '$.properties.value.enum[0]',
      'enum value does not match declared type "string"',
    ],
    [
      {
        type: 'object',
        properties: {
          value: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
            enum: [{}],
          },
        },
        required: ['value'],
        additionalProperties: false,
      },
      '$.properties.value.enum[0]',
      'enum entries must be primitive JSON values',
    ],
  ])('rejects incompatible schemas at %s', (schema, path, reason) => {
    expect(() => compileCodexOutputSchema(
      schema as Record<string, unknown>,
    )).toThrowError(
      expect.objectContaining({
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
        message: expect.stringContaining(`${path}: ${reason}`),
      }),
    );
  });

  it('reports restoration shape and JSON failures as ordinary errors', () => {
    const codec = compileCodexOutputSchema({
      type: 'object',
      properties: {
        values: { type: 'array', items: { type: 'string' } },
      },
      required: ['values'],
      additionalProperties: false,
    });

    expect(() => codec.restore('{')).toThrow(
      'codex outputSchema restoration at $: invalid JSON',
    );
    expect(() => codec.restore('{"values":{}}')).toThrow(
      'codex outputSchema restoration at $.values: expected array',
    );
    expect(() => codec.restore('null')).toThrow(
      'codex outputSchema restoration at $: expected object',
    );
  });
});
