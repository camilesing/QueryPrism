// quota-policy unit tests — subject attribution and budget resolution are
// the security/cost boundary of M7.
import {
  dayKey,
  effectiveSqlHash,
  normalizeSqlForHash,
  pickDailyLimit,
  resolveSubject,
} from './quota-policy';
import type { RequestContextData } from '../common/context/request-context';

describe('resolveSubject', () => {
  it('prefers the assistant header over agent over user', () => {
    const ctx: RequestContextData = {
      user: { id: 7, oid: 1 },
      assistant: {
        id: 42,
        oid: 1,
        type: 4,
        domain: null,
        configuration: null,
        appId: 'a',
      },
      agent: { type: 'mcp_integration', id: 9 },
    };
    expect(resolveSubject(ctx)).toEqual({ type: 'assistant', id: 42 });
  });

  it('attributes MCP traffic to the integration, not the integration user', () => {
    const ctx: RequestContextData = {
      user: { id: 7, oid: 1 },
      agent: { type: 'mcp_integration', id: 9 },
    };
    expect(resolveSubject(ctx)).toEqual({ type: 'mcp_integration', id: 9 });
  });

  it('regression context is exempt', () => {
    const ctx: RequestContextData = {
      user: { id: 1, oid: 1 },
      agent: { type: 'regression' },
    };
    expect(resolveSubject(ctx)).toEqual({ type: 'regression', id: null });
  });

  it('falls back to the plain page user', () => {
    expect(resolveSubject({ user: { id: 7, oid: 1 } })).toEqual({
      type: 'user',
      id: 7,
    });
  });

  it('returns null without any identity', () => {
    expect(resolveSubject(undefined)).toBeNull();
    expect(resolveSubject({})).toBeNull();
  });
});

describe('pickDailyLimit', () => {
  const rows = [
    { subjectType: 'default', subjectId: 0, dailyLimit: 100 },
    { subjectType: 'user', subjectId: 7, dailyLimit: 5 },
  ];

  it('the subject row wins over the default row', () => {
    expect(pickDailyLimit(rows, { type: 'user', id: 7 })).toBe(5);
  });

  it('falls back to the workspace default row', () => {
    expect(pickDailyLimit(rows, { type: 'user', id: 8 })).toBe(100);
    expect(pickDailyLimit(rows, { type: 'mcp_integration', id: 3 })).toBe(100);
  });

  it('null when nothing is configured (unlimited)', () => {
    expect(pickDailyLimit([], { type: 'user', id: 7 })).toBeNull();
  });

  it('regression never resolves a limit', () => {
    expect(pickDailyLimit(rows, { type: 'regression', id: null })).toBeNull();
  });
});

describe('dayKey', () => {
  it('formats the local calendar day', () => {
    expect(dayKey(new Date(2026, 10, 9, 23, 59))).toBe('2026-11-09');
    expect(dayKey(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});

describe('effectiveSqlHash', () => {
  it('collapses whitespace but preserves case (string literals differ)', () => {
    expect(effectiveSqlHash('SELECT 1  FROM t')).toBe(
      effectiveSqlHash(' SELECT 1 FROM t '),
    );
    expect(effectiveSqlHash("SELECT 'A'")).not.toBe(
      effectiveSqlHash("SELECT 'a'"),
    );
  });

  it('different limits produce different keys', () => {
    const a = effectiveSqlHash('SELECT * FROM t LIMIT 10');
    const b = effectiveSqlHash('SELECT * FROM t LIMIT 1000');
    expect(a).not.toBe(b);
  });

  it('normalizeSqlForHash strips nothing but whitespace', () => {
    expect(normalizeSqlForHash(' a\n b\t c ')).toBe('a b c');
  });
});
