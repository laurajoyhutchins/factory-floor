import { describe, expect, it } from 'vitest';
import { normalize } from './index.js';

describe('inspection response normalization', () => {
  it('normalizes transport fields without rewriting opaque runtime JSON', () => {
    expect(
      normalize({
        next_cursor: 'opaque',
        items: [
          {
            created_at: '2026-07-16T00:00:00.000Z',
            provenance: { model_score: 0.7, modelScore: 0.8 },
            payload: { source_id: 'external-name', sourceId: 'other-name' },
            configuration: { retry_policy: { max_attempts: 4 } },
            attributes: { billing_code: 'A-1' },
            normalized_inputs: { user_choice: 'keep_this_key' },
            inputPayload: { source_key: 'keep_this_key_too' },
            modifications: { output_name: 'keep_this_too' },
            failure: { error_code: 'opaque_failure' },
          },
        ],
      }),
    ).toEqual({
      nextCursor: 'opaque',
      items: [
        {
          createdAt: '2026-07-16T00:00:00.000Z',
          provenance: { model_score: 0.7, modelScore: 0.8 },
          payload: { source_id: 'external-name', sourceId: 'other-name' },
          configuration: { retry_policy: { max_attempts: 4 } },
          attributes: { billing_code: 'A-1' },
          normalizedInputs: { user_choice: 'keep_this_key' },
          inputPayload: { source_key: 'keep_this_key_too' },
          modifications: { output_name: 'keep_this_too' },
          failure: { error_code: 'opaque_failure' },
        },
      ],
    });
  });
});
