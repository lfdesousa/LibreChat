import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { evidenceV3, evidenceV3Image } from 'test/evidenceFixtures';
import { initializeI18n } from '~/locales/i18n';
import EvidenceDialog from '../EvidenceDialog';

/**
 * G17 — every rendered value comes from the frozen fixtures (v3, v3-image); the integrity wording
 * is one of exactly three labels; the image records are shown as lines, never as bytes; "who can
 * see this" speaks about this audit record only.
 */

const mockUseEvidenceQuery = jest.fn();
jest.mock('~/data-provider/Evidence', () => ({
  useEvidenceQuery: (...args: unknown[]) => mockUseEvidenceQuery(...args),
}));

const ok = (data: unknown) => ({ data, isLoading: false, isError: false, error: null });
const fail = (status?: number) => ({
  data: undefined,
  isLoading: false,
  isError: true,
  error: { response: status === undefined ? undefined : { status } },
});

const renderDialog = () =>
  render(<EvidenceDialog open messageId="msg-1" onOpenChange={jest.fn()} />);

const openTab = async (name: RegExp) => {
  await userEvent.click(screen.getByRole('tab', { name }));
};

beforeAll(async () => {
  await initializeI18n();
});

describe('EvidenceDialog — Reconstruct tab (v3 fixture)', () => {
  const fx = evidenceV3();

  beforeEach(() => mockUseEvidenceQuery.mockReturnValue(ok(fx)));

  it('queries by the message id, only while open', () => {
    renderDialog();
    expect(mockUseEvidenceQuery).toHaveBeenCalledWith('msg-1', true);
  });

  it('shows the reconstruct values from the payload', () => {
    renderDialog();
    expect(screen.getByText(fx.interaction.trace_id)).toBeInTheDocument();
    expect(screen.getByText(fx.interaction.model)).toBeInTheDocument();
    expect(screen.getByText(fx.interaction.timestamp)).toBeInTheDocument();
    expect(screen.getByText('1.0 s')).toBeInTheDocument();
    expect(screen.getByText('10 prompt, 5 completion')).toBeInTheDocument();
    expect(screen.getByText(String(fx.interaction.id))).toBeInTheDocument();
    expect(screen.getByText(fx.lookup.value)).toBeInTheDocument();
    expect(screen.getByText(fx.integrity.content_hash)).toBeInTheDocument();
  });

  it('shows the tool calls with their granted scope', () => {
    renderDialog();
    expect(screen.getByText(/recall_semantic/)).toBeInTheDocument();
    expect(screen.getByText(/memory:semantic:read/)).toBeInTheDocument();
  });

  it('labels a matching hash exactly "Integrity: match"', () => {
    renderDialog();
    expect(screen.getByText('Integrity: match')).toBeInTheDocument();
  });

  it('labels a mismatch exactly "Integrity: mismatch"', () => {
    mockUseEvidenceQuery.mockReturnValue(
      ok({ ...fx, integrity: { ...fx.integrity, recomputed: 'mismatch' } }),
    );
    renderDialog();
    expect(screen.getByText('Integrity: mismatch')).toBeInTheDocument();
    expect(screen.queryByText('Integrity: match')).not.toBeInTheDocument();
  });

  it('says plainly "Integrity: not recorded for this row type" for an unavailable hash', () => {
    mockUseEvidenceQuery.mockReturnValue(
      ok({ ...fx, integrity: { ...fx.integrity, content_hash: null, recomputed: 'unavailable' } }),
    );
    renderDialog();
    expect(screen.getByText('Integrity: not recorded for this row type')).toBeInTheDocument();
    expect(screen.queryByText(/Integrity: match/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Integrity: mismatch/)).not.toBeInTheDocument();
  });

  it.each(['verified', '', 'MATCH', null, 42])(
    'never reads an unknown recomputed value (%p) as verified',
    (value) => {
      mockUseEvidenceQuery.mockReturnValue(
        ok({ ...fx, integrity: { ...fx.integrity, recomputed: value } }),
      );
      renderDialog();
      expect(screen.getByText('Integrity: not recorded for this row type')).toBeInTheDocument();
      expect(screen.queryByText(/Integrity: (match|mismatch)/)).not.toBeInTheDocument();
    },
  );

  it('notes a continued answer when several rows share the message id', () => {
    mockUseEvidenceQuery.mockReturnValue(ok({ ...fx, lookup: { ...fx.lookup, candidates: 3 } }));
    renderDialog();
    expect(screen.getByText(/3 audit records share this message id/)).toBeInTheDocument();
  });

  it('shows no image section for a text-only row', () => {
    renderDialog();
    expect(screen.queryByText('Images in the question')).not.toBeInTheDocument();
  });
});

describe('EvidenceDialog — image records (v3-image fixture, operator ruling Q3)', () => {
  const fx = evidenceV3Image();
  const item = fx.interaction.input_media.items[0];

  beforeEach(() => mockUseEvidenceQuery.mockReturnValue(ok(fx)));

  it('shows one line per image: type, size, sha256 and the not-stored note', () => {
    renderDialog();
    const line = screen.getByTestId('evidence-image-0');
    expect(line).toHaveTextContent(item.media_type);
    expect(line).toHaveTextContent(`${item.bytes} bytes`);
    expect(line).toHaveTextContent(`sha256 ${item.sha256}`);
    expect(line).toHaveTextContent('The image itself is not stored.');
  });

  it('renders no image element and no data URL, whatever the payload carries', () => {
    const hostile = JSON.parse(JSON.stringify(fx));
    hostile.interaction.input_media.items[0].data = 'data:image/png;base64,AAAAAAAA';
    hostile.interaction.input_media.items[0].data_uri = 'data:image/png;base64,BBBBBBBB';
    hostile.interaction.input_media.items[0].url = 'https://example.invalid/x.png';
    mockUseEvidenceQuery.mockReturnValue(ok(hostile));
    const { container } = renderDialog();
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('canvas')).toBeNull();
    expect(document.body.innerHTML).not.toContain('data:');
    expect(document.body.innerHTML).not.toContain('AAAAAAAA');
    expect(document.body.innerHTML).not.toContain('BBBBBBBB');
    expect(document.body.innerHTML).not.toContain('example.invalid');
    expect(container).toBeDefined();
  });

  it('shows two lines for two images', () => {
    const two = JSON.parse(JSON.stringify(fx));
    two.interaction.input_media.items.push({ ...item, part_index: 2, bytes: 70 });
    two.interaction.input_media.count = 2;
    mockUseEvidenceQuery.mockReturnValue(ok(two));
    renderDialog();
    expect(screen.getByTestId('evidence-image-0')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-image-1')).toHaveTextContent('70 bytes');
  });

  it('flags an image whose record is not "recorded" instead of presenting it as recorded', () => {
    const odd = JSON.parse(JSON.stringify(fx));
    odd.interaction.input_media.items[0].status = 'failed';
    mockUseEvidenceQuery.mockReturnValue(ok(odd));
    renderDialog();
    expect(screen.getByTestId('evidence-image-0')).toHaveTextContent('failed');
  });
});

describe('EvidenceDialog — Sources tab', () => {
  const fx = evidenceV3();

  it('lists each source with its tier and who owns it', async () => {
    mockUseEvidenceQuery.mockReturnValue(ok(fx));
    renderDialog();
    await openTab(/sources/i);
    const first = screen.getByTestId('evidence-source-0');
    expect(first).toHaveTextContent('fixture-corpus-doc.md');
    expect(first).toHaveTextContent('corpus');
    expect(first).toHaveTextContent('not owned by you');
    const second = screen.getByTestId('evidence-source-1');
    expect(second).toHaveTextContent('fixture-private-doc.md');
    expect(second).toHaveTextContent('private');
    expect(second).toHaveTextContent('owned by you');
  });

  it('renders "not_recorded" verbatim and never an empty list that reads as "found nothing"', async () => {
    mockUseEvidenceQuery.mockReturnValue(
      ok({ ...fx, sources: { status: 'not_recorded', items: [] } }),
    );
    renderDialog();
    await openTab(/sources/i);
    expect(screen.getByText(/not_recorded/)).toBeInTheDocument();
    expect(screen.queryByTestId('evidence-source-0')).not.toBeInTheDocument();
  });
});

describe('EvidenceDialog — Who can see this (this audit record only)', () => {
  const fx = evidenceV3();

  beforeEach(() => mockUseEvidenceQuery.mockReturnValue(ok(fx)));

  it('derives both lines from the payload', async () => {
    renderDialog();
    await openTab(/who can see this/i);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Visible via the API to: you (owner)')).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Read by the service role audittrace_summariser for session summarisation; database administrators can read the table.',
      ),
    ).toBeInTheDocument();
  });

  it('follows the payload, not a constant: other readers, other role', async () => {
    const other = JSON.parse(JSON.stringify(fx));
    other.visibility.answer.api_readers = ['owner', 'auditor'];
    other.visibility.answer.service_readers = [
      { role: 'role_x', purpose: 'indexing', basis: 'GRANT' },
    ];
    other.visibility.answer.operator_access = 'platform operators';
    mockUseEvidenceQuery.mockReturnValue(ok(other));
    renderDialog();
    await openTab(/who can see this/i);
    expect(screen.getByText('Visible via the API to: you (owner), auditor')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Read by the service role role_x for indexing; platform operators can read the table.',
      ),
    ).toBeInTheDocument();
  });

  it('renders an operator-managed service reader as unverified', async () => {
    const managed = JSON.parse(JSON.stringify(fx));
    managed.visibility.answer.service_readers = [
      { role: 'operator-managed', basis: 'unverified', purpose: 'session summarisation' },
    ];
    mockUseEvidenceQuery.mockReturnValue(ok(managed));
    renderDialog();
    await openTab(/who can see this/i);
    expect(screen.getByText(/unverified/i)).toBeInTheDocument();
    expect(screen.queryByText(/Read by the service role operator-managed/)).not.toBeInTheDocument();
  });

  it('also treats a bare "operator-managed" string as unverified', async () => {
    const managed = JSON.parse(JSON.stringify(fx));
    managed.visibility.answer.service_readers = 'operator-managed';
    mockUseEvidenceQuery.mockReturnValue(ok(managed));
    renderDialog();
    await openTab(/who can see this/i);
    expect(screen.getByText(/unverified/i)).toBeInTheDocument();
  });

  it('speaks about this audit record only and says LibreChat copies and shared links are separate', async () => {
    renderDialog();
    await openTab(/who can see this/i);
    const note = screen.getByTestId('evidence-visibility-scope');
    expect(note).toHaveTextContent('this audit record only');
    expect(note).toHaveTextContent('LibreChat');
    expect(note).toHaveTextContent('shared links');
  });
});

describe('EvidenceDialog — states', () => {
  it('shows a loading state', () => {
    mockUseEvidenceQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderDialog();
    expect(screen.getByText('Loading the audit record…')).toBeInTheDocument();
  });

  it.each([
    [404, 'No audit record was found for this answer.'],
    [403, 'You are not allowed to see this audit record.'],
    [401, 'Your session has expired. Sign in again to view the audit record.'],
    [500, 'The audit record could not be loaded.'],
    [undefined, 'The audit record could not be loaded.'],
  ])('maps status %p to a plain message with no payload', (status, message) => {
    mockUseEvidenceQuery.mockReturnValue(fail(status));
    renderDialog();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('does not query while closed', () => {
    mockUseEvidenceQuery.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<EvidenceDialog open={false} messageId="msg-1" onOpenChange={jest.fn()} />);
    expect(mockUseEvidenceQuery).toHaveBeenCalledWith('msg-1', false);
  });
});
