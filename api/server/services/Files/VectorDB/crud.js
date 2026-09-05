const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { logAxiosError, generateShortLivedToken } = require('@librechat/api');
// M3 Sovereign-Attach WU-3 — the sovereign-memory adapter's upload arm +
// its feature flag. `mongo` (default, unset) never even touches
// `callConsoleFilesProxy`'s import; `uploadVectors` guards on
// `isSovereignBackend()` BEFORE any of the `RAG_API_URL`-backed code that
// follows it, so that legacy path is untouched when the flag is at its
// default (same pattern `memories.js`/`agentMethods.js` already use).
const { isSovereignBackend } = require('~/server/services/AuditTraceMemory/config');
const { callConsoleFilesProxy } = require('~/server/services/AuditTraceMemory/consoleFilesClient');

/**
 * Deletes a file from the vector database. This function takes a file object, constructs the full path, and
 * verifies the path's validity before deleting the file. If the path is invalid, an error is thrown.
 *
 * @param {ServerRequest} req - The request object from Express.
 * @param {MongoFile} file - The file object to be deleted. It should have a `filepath` property that is
 *                           a string representing the path of the file relative to the publicPath.
 *
 * @returns {Promise<void>}
 *          A promise that resolves when the file has been successfully deleted, or throws an error if the
 *          file path is invalid or if there is an error in deletion.
 */
const deleteVectors = async (req, file) => {
  if (!file.embedded || !process.env.RAG_API_URL) {
    return;
  }
  try {
    const jwtToken = generateShortLivedToken(req.user.id);

    return await axios.delete(`${process.env.RAG_API_URL}/documents`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      data: [file.file_id],
    });
  } catch (error) {
    logAxiosError({
      error,
      message: 'Error deleting vectors',
    });
    if (
      error.response &&
      error.response.status !== 404 &&
      (error.response.status < 200 || error.response.status >= 300)
    ) {
      logger.warn('Error deleting vectors, file will not be deleted');
      throw new Error(error.message || 'An error occurred during file deletion.');
    }
  }
};

/**
 * The sovereign-backend arm of `uploadVectors` (M3 Sovereign-Attach WU-3).
 * Sends the SAME file bytes the legacy `${RAG_API_URL}/embed` call below
 * would have sent, but to the BFF's `POST /console/files` (WU-2), carrying
 * the user's REAL Keycloak OIDC access token — read off
 * `req.session.openidTokens.accessToken`, exactly as `memories.js`'s
 * `getSovereignAccessToken` does — instead of a LibreChat-internal
 * short-lived JWT. `generateShortLivedToken` is never called on this path:
 * the fork mints nothing (see the module docstring on
 * `AuditTraceMemory/consoleFilesClient.js`). The narrow
 * `memory:session:write`-only exchange and the forced `layer=session` are
 * entirely the BFF's job (WU-2, unchanged) — this function does not touch
 * either.
 *
 * Preserves the SAME file-object return contract
 * (`bytes`/`filename`/`filepath`/`embedded`) `uploadVectors` returns for
 * the legacy path, so the composer UX is unchanged regardless of backend.
 * A `SovereignMemoryError` (missing token → 401, a BFF/orchestrator 4xx/5xx
 * relayed byte-faithfully) is NEVER caught here — it propagates with its
 * `.status` intact, never reinterpreted, never retried, never a fallback
 * to the Mongo/RAG path below.
 *
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {Express.Multer.File} params.file
 * @returns {Promise<{ bytes: number, filename: string, filepath: string, embedded: boolean }>}
 */
async function uploadVectorsSovereign({ req, file }) {
  const token = req?.session?.openidTokens?.accessToken || null;
  const response = await callConsoleFilesProxy({
    token,
    filePath: file.path,
    filename: file.originalname,
    contentType: file.mimetype,
  });
  logger.debug('Response from sovereign console-files upload', response);

  return {
    bytes: file.size,
    filename: file.originalname,
    filepath: FileSources.vectordb,
    embedded: true,
  };
}

/**
 * Uploads a file to the configured Vector database
 *
 * @param {Object} params - The params object.
 * @param {Object} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 * @param {string} [params.entity_id] - The entity ID for shared resources.
 * @param {Object} [params.storageMetadata] - Storage metadata for dual storage pattern.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the file is saved.
 *            - bytes: The size of the file in bytes.
 */
async function uploadVectors({ req, file, file_id, entity_id, storageMetadata }) {
  // M3 Sovereign-Attach WU-3 — sovereign backend routes the upload
  // through the audited BFF seam INSTEAD of `${RAG_API_URL}/embed` below.
  // `mongo` (default) falls through to the unchanged legacy code — same
  // reference-preserving guard-at-top pattern as `memories.js`.
  if (isSovereignBackend()) {
    return uploadVectorsSovereign({ req, file });
  }

  if (!process.env.RAG_API_URL) {
    throw new Error('RAG_API_URL not defined');
  }

  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const formData = new FormData();
    formData.append('file_id', file_id);
    formData.append('file', fs.createReadStream(file.path));
    if (entity_id != null && entity_id) {
      formData.append('entity_id', entity_id);
    }

    // Include storage metadata for RAG API to store with embeddings
    if (storageMetadata) {
      formData.append('storage_metadata', JSON.stringify(storageMetadata));
    }

    const formHeaders = formData.getHeaders();

    const response = await axios.post(`${process.env.RAG_API_URL}/embed`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formHeaders,
      },
    });

    const responseData = response.data;
    logger.debug('Response from embedding file', responseData);

    if (responseData.known_type === false) {
      throw new Error(`File embedding failed. The filetype ${file.mimetype} is not supported`);
    }

    if (!responseData.status) {
      throw new Error('File embedding failed.');
    }

    return {
      bytes: file.size,
      filename: file.originalname,
      filepath: FileSources.vectordb,
      embedded: Boolean(responseData.known_type),
    };
  } catch (error) {
    logAxiosError({
      error,
      message: 'Error uploading vectors',
    });
    throw new Error(error.message || 'An error occurred during file upload.');
  }
}

module.exports = {
  deleteVectors,
  uploadVectors,
  // Exported for direct unit-testing of the sovereign branch (M3
  // Sovereign-Attach WU-3) — not part of the strategy-function surface
  // `strategies.js` consumes (that stays `uploadVectors` only).
  uploadVectorsSovereign,
};
