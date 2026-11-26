import React from 'react';
import { request } from 'librechat-data-provider';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { evidenceMessagePath, useEvidenceQuery } from '../queries';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('evidenceMessagePath — the fork API route is the only data path (G20c, client side)', () => {
  it('builds the fork route path with an encoded id', () => {
    expect(evidenceMessagePath('00000000-0000-4000-8000-00000000000b')).toMatch(
      /\/api\/audittrace\/evidence\/messages\/00000000-0000-4000-8000-00000000000b$/,
    );
    expect(evidenceMessagePath('a:b')).toMatch(/\/messages\/a%3Ab$/);
  });

  it.each(['', '.', '..', '../x', 'a/b', 'a b', 'abc\n', 'x'.repeat(256), '%2e%2e'])(
    'returns null for the id %j so nothing is requested',
    (id) => {
      expect(evidenceMessagePath(id)).toBeNull();
    },
  );

  it('never targets the BFF or the memory server directly', () => {
    const path = evidenceMessagePath('abc') as string;
    expect(path).not.toContain('/console/evidence');
    expect(path).not.toMatch(/^https?:/);
  });
});

describe('useEvidenceQuery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('GETs the fork route once when enabled and returns the body unchanged', async () => {
    const body = { contract: 'audittrace.evidence.v1' };
    const get = jest.spyOn(request, 'get').mockResolvedValue(body);
    const { result } = renderHook(() => useEvidenceQuery('msg-1', true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(body));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toMatch(/\/api\/audittrace\/evidence\/messages\/msg-1$/);
  });

  it('does not request anything while disabled', () => {
    const get = jest.spyOn(request, 'get').mockResolvedValue({});
    renderHook(() => useEvidenceQuery('msg-1', false), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });

  it('does not request anything for an id that fails the predicate', () => {
    const get = jest.spyOn(request, 'get').mockResolvedValue({});
    renderHook(() => useEvidenceQuery('../x', true), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });

  it('does not retry a refusal', async () => {
    const get = jest.spyOn(request, 'get').mockRejectedValue({ response: { status: 404 } });
    const client = new QueryClient();
    const local = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useEvidenceQuery('msg-1', true), { wrapper: local });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
