const axios = require('axios');

const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const MAX_FOLDER_DEPTH = 100;

function serviceError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createDriveService(httpClient = axios, env = process.env) {
  let tokenCache = null;
  let tokenRequest = null;

  function oauthConfig() {
    const config = {
      clientId: env.GOOGLE_DRIVE_CLIENT_ID,
      clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_DRIVE_REFRESH_TOKEN,
    };

    const missing = Object.entries(config)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length) {
      throw serviceError(
        `Configuración de Google Drive incompleta: ${missing.join(', ')}.`,
        503
      );
    }

    return config;
  }

  function rootFolderId(root) {
    const roots = {
      vehicles: env.GOOGLE_DRIVE_VEHICLE_FOLDER_ID,
      invoices: env.GOOGLE_DRIVE_INVOICE_FOLDER_ID,
    };

    if (!Object.prototype.hasOwnProperty.call(roots, root)) {
      throw serviceError('Raíz de almacenamiento no permitida.', 400);
    }
    if (!roots[root]) {
      throw serviceError(
        `La carpeta raíz de Google Drive para "${root}" no está configurada.`,
        503
      );
    }

    return roots[root];
  }

  function configuredRootIds() {
    const ids = [
      env.GOOGLE_DRIVE_VEHICLE_FOLDER_ID,
      env.GOOGLE_DRIVE_INVOICE_FOLDER_ID,
    ].filter(Boolean);

    if (!ids.length) {
      throw serviceError(
        'No hay carpetas raíz de Google Drive configuradas.',
        503
      );
    }

    return new Set(ids);
  }

  function folderSegments(folderPath) {
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      throw serviceError('La ruta de la carpeta no es válida.', 400);
    }

    const segments = folderPath.split('/').map(segment => segment.trim());
    if (
      segments.length > MAX_FOLDER_DEPTH ||
      segments.some(
        segment =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          segment.length > 150 ||
          /[\u0000-\u001f]/.test(segment)
      )
    ) {
      throw serviceError('La ruta de la carpeta no es válida.', 400);
    }

    return segments;
  }

  function safeFileName(fileName) {
    if (
      typeof fileName !== 'string' ||
      !fileName.trim() ||
      fileName.length > 200 ||
      /[\/\\\u0000-\u001f]/.test(fileName)
    ) {
      throw serviceError('El nombre del archivo no es válido.', 400);
    }
    return fileName.trim();
  }

  function safeFileId(fileId) {
    if (
      typeof fileId !== 'string' ||
      !/^[A-Za-z0-9_-]{5,200}$/.test(fileId)
    ) {
      throw serviceError('El identificador del archivo no es válido.', 400);
    }
    return fileId;
  }

  function escapeDriveQueryValue(value) {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async function accessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.value;
    }

    if (!tokenRequest) {
      tokenRequest = (async () => {
        const config = oauthConfig();
        const body = new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: config.refreshToken,
          grant_type: 'refresh_token',
        });

        try {
          const response = await httpClient.post(GOOGLE_TOKEN_URL, body.toString(), {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            timeout: 15_000,
          });
          const value = response.data?.access_token;
          if (!value) {
            throw new Error('Google no devolvió un access token.');
          }

          tokenCache = {
            value,
            expiresAt:
              Date.now() + Math.max(Number(response.data.expires_in) || 3600, 120) * 1000,
          };
          return value;
        } catch (error) {
          tokenCache = null;
          const detail =
            error.response?.data?.error_description ||
            error.response?.data?.error ||
            error.message;
          console.error('[Drive] No fue posible renovar el token OAuth:', detail);
          throw serviceError('No fue posible autenticar Google Drive.', 502);
        }
      })().finally(() => {
        tokenRequest = null;
      });
    }

    return tokenRequest;
  }

  async function driveRequest(options, canRetry = true) {
    const token = await accessToken();

    try {
      return await httpClient.request({
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${token}`,
        },
        timeout: options.timeout || 30_000,
      });
    } catch (error) {
      if (canRetry && error.response?.status === 401) {
        tokenCache = null;
        return driveRequest(options, false);
      }
      throw error;
    }
  }

  async function findFolder(parentId, name) {
    const escapedName = escapeDriveQueryValue(name);
    const escapedParent = escapeDriveQueryValue(parentId);
    const response = await driveRequest({
      method: 'GET',
      url: `${DRIVE_API_URL}/files`,
      params: {
        q:
          `'${escapedParent}' in parents and ` +
          `name = '${escapedName}' and ` +
          `mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
        fields: 'files(id,name)',
        pageSize: 1,
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });

    return response.data?.files?.[0] || null;
  }

  async function createFolder(parentId, name) {
    const response = await driveRequest({
      method: 'POST',
      url: `${DRIVE_API_URL}/files`,
      params: {
        fields: 'id,name',
        supportsAllDrives: true,
      },
      data: {
        name,
        mimeType: FOLDER_MIME_TYPE,
        parents: [parentId],
      },
    });
    return response.data;
  }

  async function ensureFolderPath(rootId, folderPath) {
    let parentId = rootId;

    for (const segment of folderSegments(folderPath)) {
      const existing = await findFolder(parentId, segment);
      const folder = existing || (await createFolder(parentId, segment));
      if (!folder?.id) {
        throw new Error(`Google Drive no creó la carpeta "${segment}".`);
      }
      parentId = folder.id;
    }

    return parentId;
  }

  function multipartBody(metadata, buffer, mimeType) {
    const boundary = `vehicleapp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);

    return {
      boundary,
      data: Buffer.concat([prefix, buffer, suffix]),
    };
  }

  async function uploadPrivateFile({
    buffer,
    fileName,
    mimeType,
    folderPath,
    root,
  }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw serviceError('El contenido del archivo no es válido.', 400);
    }
    if (typeof mimeType !== 'string' || !mimeType.trim()) {
      throw serviceError('El tipo del archivo no es válido.', 400);
    }

    const rootId = rootFolderId(root);
    const parentId = await ensureFolderPath(rootId, folderPath);
    const metadata = {
      name: safeFileName(fileName),
      parents: [parentId],
      appProperties: {
        vehicleAppManaged: 'true',
        storageRoot: root,
      },
    };
    const multipart = multipartBody(metadata, buffer, mimeType);
    const response = await driveRequest({
      method: 'POST',
      url: `${DRIVE_UPLOAD_URL}/files`,
      params: {
        uploadType: 'multipart',
        fields: 'id,name,mimeType,size,parents',
        supportsAllDrives: true,
      },
      headers: {
        'Content-Type': `multipart/related; boundary=${multipart.boundary}`,
      },
      data: multipart.data,
      maxBodyLength: Infinity,
      timeout: 60_000,
    });

    if (!response.data?.id) {
      throw new Error('Google Drive no devolvió el identificador del archivo.');
    }
    return response.data;
  }

  async function fileMetadata(fileId) {
    return driveRequest({
      method: 'GET',
      url: `${DRIVE_API_URL}/files/${fileId}`,
      params: {
        fields: 'id,mimeType,parents,trashed',
        supportsAllDrives: true,
      },
    });
  }

  async function assertFileIsManaged(fileId) {
    const id = safeFileId(fileId);
    const roots = configuredRootIds();
    let pendingIds = [id];
    const visited = new Set();

    for (let depth = 0; pendingIds.length && depth <= MAX_FOLDER_DEPTH; depth += 1) {
      const nextIds = [];

      for (const currentId of pendingIds) {
        if (roots.has(currentId)) {
          return id;
        }
        if (visited.has(currentId)) {
          continue;
        }
        visited.add(currentId);

        const response = await fileMetadata(currentId);
        if (response.data?.trashed) {
          const error = serviceError('Archivo no encontrado.', 404);
          error.response = {status: 404};
          throw error;
        }
        nextIds.push(...(response.data?.parents || []));
      }

      pendingIds = nextIds;
    }

    throw serviceError(
      'El archivo no pertenece al almacenamiento administrado por la aplicación.',
      403
    );
  }

  async function downloadPrivateFile(fileId) {
    const id = await assertFileIsManaged(fileId);
    return driveRequest({
      method: 'GET',
      url: `${DRIVE_API_URL}/files/${id}`,
      params: {
        alt: 'media',
        supportsAllDrives: true,
      },
      responseType: 'stream',
      timeout: 60_000,
    });
  }

  async function deletePrivateFile(fileId) {
    const id = await assertFileIsManaged(fileId);
    await driveRequest({
      method: 'DELETE',
      url: `${DRIVE_API_URL}/files/${id}`,
      params: {supportsAllDrives: true},
    });
  }

  return {
    uploadPrivateFile,
    downloadPrivateFile,
    deletePrivateFile,
  };
}

const driveService = createDriveService();

module.exports = {
  ...driveService,
  createDriveService,
};
