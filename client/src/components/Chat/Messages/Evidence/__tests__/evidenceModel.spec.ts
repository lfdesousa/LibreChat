import { serviceReaderLines } from '../evidenceModel';

/**
 * Each condition that marks a service reader "unverified" is pinned alone: the orchestrator always
 * emits role `operator-managed` together with basis `unverified`, so a spec that only ever uses the
 * pair cannot tell which half is doing the work.
 */
describe('serviceReaderLines', () => {
  it('names a reader that has a real role, a purpose and a grant basis', () => {
    expect(serviceReaderLines([{ role: 'r', purpose: 'p', basis: 'GRANT' }])).toEqual([
      { kind: 'named', role: 'r', purpose: 'p' },
    ]);
  });

  it('role operator-managed alone makes it unverified', () => {
    expect(serviceReaderLines([{ role: 'operator-managed', purpose: 'p', basis: 'x' }])).toEqual([
      { kind: 'unverified' },
    ]);
  });

  it('basis unverified alone makes it unverified', () => {
    expect(serviceReaderLines([{ role: 'r', purpose: 'p', basis: 'unverified' }])).toEqual([
      { kind: 'unverified' },
    ]);
  });

  it('a reader without a purpose, or without a role, cannot be stated', () => {
    expect(serviceReaderLines([{ role: 'r', basis: 'GRANT' }])).toEqual([{ kind: 'unverified' }]);
    expect(serviceReaderLines([{ purpose: 'p', basis: 'GRANT' }])).toEqual([
      { kind: 'unverified' },
    ]);
  });

  it('says unverified once however many readers are unverified, and keeps the named ones', () => {
    expect(
      serviceReaderLines([
        { role: 'operator-managed', purpose: 'p', basis: 'unverified' },
        { role: 'r', purpose: 'p', basis: 'unverified' },
        { role: 'ok', purpose: 'q', basis: 'GRANT' },
      ]),
    ).toEqual([{ kind: 'unverified' }, { kind: 'named', role: 'ok', purpose: 'q' }]);
  });

  it('a bare string, a non-list value is unverified; absent is no line', () => {
    expect(serviceReaderLines('operator-managed')).toEqual([{ kind: 'unverified' }]);
    expect(serviceReaderLines({} as unknown as string)).toEqual([{ kind: 'unverified' }]);
    expect(serviceReaderLines(undefined)).toEqual([]);
  });
});
