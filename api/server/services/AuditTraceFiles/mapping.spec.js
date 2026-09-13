const { isPlainObject, fileExtraMetadata, fileUpsertBody, apiToFile } = require('./mapping');

describe('AuditTraceFiles/mapping — pure LibreChat <-> /console/file-records field mapping', () => {
  describe('isPlainObject', () => {
    it('is true for a plain object, false for arrays/null/primitives', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject('x')).toBe(false);
    });
  });

  describe('fileExtraMetadata', () => {
    it('collects every LibreChat-only field into the metadata bag, dropping undefined and non-metadata keys', () => {
      const data = {
        source: 's3',
        filepath: 'https://signed.example/x',
        storageRegion: 'eu-west-1',
        text: 'hello',
        textFormat: 'text',
        status: 'ready',
        previewError: undefined,
        previewRevision: 'uuid-1',
        conversationId: 'c1',
        messageId: 'm1',
        model: 'gpt',
        tenantId: 't1',
        filename: 'ignored.txt',
        user: 'ignored-owner',
      };
      expect(fileExtraMetadata(data)).toEqual({
        source: 's3',
        filepath: 'https://signed.example/x',
        storageRegion: 'eu-west-1',
        text: 'hello',
        textFormat: 'text',
        status: 'ready',
        previewRevision: 'uuid-1',
        conversationId: 'c1',
        messageId: 'm1',
        model: 'gpt',
        tenantId: 't1',
      });
    });

    it('tolerates undefined/null input', () => {
      expect(fileExtraMetadata(undefined)).toEqual({});
      expect(fileExtraMetadata(null)).toEqual({});
    });
  });

  describe('fileUpsertBody', () => {
    it('maps first-class columns, bridges usage to {count}, and emits NO owner field', () => {
      const body = fileUpsertBody('f1', {
        filename: 'a.png',
        type: 'image/png',
        bytes: 10,
        storageKey: 'images/u1/f1__a.png',
        width: 1,
        height: 2,
        context: 'message_attachment',
        usage: 3,
        embedded: true,
        temp_file_id: 'tmp',
        text: 'hello',
        user: 'must-not-be-sent',
        user_sub: 'must-not-be-sent',
      });
      expect(body).toEqual({
        file_id: 'f1',
        filename: 'a.png',
        type: 'image/png',
        bytes: 10,
        object_key: 'images/u1/f1__a.png',
        width: 1,
        height: 2,
        context: 'message_attachment',
        usage: { count: 3 },
        embedded: true,
        temp_file_id: 'tmp',
        metadata: { text: 'hello' },
      });
      expect('user' in body).toBe(false);
      expect('user_sub' in body).toBe(false);
    });

    it('applies safe defaults for missing/mistyped fields', () => {
      const body = fileUpsertBody('f1', { filename: 42, bytes: 'x', usage: 'many' });
      expect(body.filename).toBe('');
      expect(body.type).toBe('application/octet-stream');
      expect(body.bytes).toBe(0);
      expect(body.usage).toEqual({ count: 0 });
      expect(body.object_key).toBeUndefined();
      expect(body.embedded).toBe(false);
      expect(fileUpsertBody('f1', undefined).file_id).toBe('f1');
      expect(fileUpsertBody('f1', null).file_id).toBe('f1');
    });
  });

  describe('apiToFile', () => {
    const fullItem = {
      file_id: 'f1',
      user_sub: 'kc-sub-1',
      filename: 'a.png',
      type: 'image/png',
      bytes: 1234,
      object_key: 'images/u1/f1__a.png',
      width: 100,
      height: 200,
      context: 'message_attachment',
      usage: { count: 5 },
      embedded: true,
      temp_file_id: 'tmp-1',
      created_at_ms: 1000,
      updated_at_ms: 2000,
      metadata: {
        source: 's3',
        filepath: 'https://signed.example/x',
        storageRegion: 'eu-west-1',
        text: 'hello',
        textFormat: 'text',
        status: 'ready',
        previewError: 'timeout',
        previewRevision: 'uuid-1',
        conversationId: 'c1',
        messageId: 'm1',
        model: 'gpt',
        tenantId: 't1',
      },
    };

    it('round-trips a full ConsoleFileItem back to the Mongo IMongoFile shape', () => {
      const file = apiToFile(fullItem);
      expect(file).toMatchObject({
        file_id: 'f1',
        filename: 'a.png',
        filepath: 'https://signed.example/x',
        storageKey: 'images/u1/f1__a.png',
        storageRegion: 'eu-west-1',
        object: 'file',
        embedded: true,
        type: 'image/png',
        context: 'message_attachment',
        usage: 5,
        source: 's3',
        model: 'gpt',
        width: 100,
        height: 200,
        bytes: 1234,
        text: 'hello',
        textFormat: 'text',
        status: 'ready',
        previewError: 'timeout',
        previewRevision: 'uuid-1',
        conversationId: 'c1',
        messageId: 'm1',
        temp_file_id: 'tmp-1',
        tenantId: 't1',
      });
      expect(file.createdAt).toEqual(new Date(1000));
      expect(file.updatedAt).toEqual(new Date(2000));
    });

    it('emits `_id` = file_id (a string) so the {_id: file._id} text re-fetch is an id-shaped, own-scoped read (reviewer F6)', () => {
      const file = apiToFile(fullItem);
      expect(file._id).toBe('f1');
      expect(typeof file._id).toBe('string');
      expect(file._id.toString()).toBe('f1');
    });

    it("emits NO owner field — `user` is the base's to stamp from the request context, never the mapping's (files-v2 F3)", () => {
      const file = apiToFile(fullItem, 'attacker-supplied-other-user');
      expect('user' in file).toBe(false);
      expect('user_sub' in file).toBe(false);
      expect(JSON.stringify(file)).not.toContain('attacker-supplied');
    });

    it('defaults usage to 0, source to local, filepath to "" and bytes to 0 on a bare row', () => {
      const file = apiToFile({
        file_id: 'f1',
        user_sub: 'kc-sub-1',
        filename: 'a.txt',
        type: 'text/plain',
        created_at_ms: 1,
        updated_at_ms: 1,
      });
      expect(file.usage).toBe(0);
      expect(file.source).toBe('local');
      expect(file.filepath).toBe('');
      expect(file.bytes).toBe(0);
      expect(file.storageKey).toBeUndefined();
      expect(file.temp_file_id).toBeUndefined();
      expect(file.context).toBeUndefined();
    });
  });
});
