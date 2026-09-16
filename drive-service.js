const axios = require('axios');

const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const MAX_FOLDER_DEPTH = 100;
const VEHICLE_PHOTO_CATEGORIES = new Set([
  'ac',
  'cojines',
  'detalles',
  'frontal',
  'guantera',
  'motor',
  'tablero',
]);
const RESERVED_APP_PROPERTIES = new Set([
  'vehicleAppManaged',
  'storageRoot',
  'uploadRequestId',
  'vehicleAppWorkshopFolder',
]);
const WORKSHOP_FOLDER_PROPERTY = 'vehicleAppWorkshopFolder';

function serviceError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function vehiclePhotoFolderPath(vehiclePlate, category) {
  const normalizedPlate = String(vehiclePlate || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const normalizedCategory = String(category || '').trim().toLowerCase();

  if (normalizedPlate.length < 5 || normalizedPlate.length > 10) {
    throw serviceError('La placa del vehículo no es válida.', 400);
  }
  if (!VEHICLE_PHOTO_CATEGORIES.has(normalizedCategory)) {
    throw serviceError('La categoría de la foto no está permitida.', 400);
  }

  return `${normalizedPlate}/${normalizedCategory}`;
}

function normalizeWorkshop(workshop) {
  const id = String(workshop?.id || '').trim().toLowerCase();
  const name = String(workshop?.name || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
      !name || name.length > 120) {
    throw serviceError('Los datos del taller no son válidos.', 400);
  }
  const safeName = name
    .replace(/[\/\\\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safeName) throw serviceError('Los datos del taller no son válidos.', 400);
  return {id, name: safeName, folderName: `${safeName} · ${id.slice(0, 8)}`};
}

function asciiSlug(value, fallback) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (slug || fallback).slice(0, 48);
}

function workshopFileName({root, folderPath, mimeType, uploadRequestId, now = new Date()}) {
  const segments = String(folderPath || '').split('/').map(value => value.trim()).filter(Boolean);
  const plate = String(segments[0] || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'sin-placa';
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const requestSuffix = asciiSlug(uploadRequestId, 'archivo').slice(-12);
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'application/pdf': 'pdf',
    'application/xml': 'xml',
    'text/xml': 'xml',
  };
  const extension = extensions[String(mimeType || '').toLowerCase()] || 'bin';

  if (root === 'vehicles') {
    const category = asciiSlug(segments[1], 'general');
    return `foto_${plate}_${category}_${timestamp}_${requestSuffix}.${extension}`;
  }
  const provider = segments[1] === 'facturas_compras' ? segments.slice(2).join('-') : segments.slice(1).join('-');
  return `factura-proveedor_${plate}_${asciiSlug(provider, 'sin-proveedor')}_${timestamp}_${requestSuffix}.${extension}`;
}

function createDriveService(httpClient = axios, env = process.env) {
  let tokenCache = null;
  let tokenRequest = null;
  // Vercel puede reutilizar la instancia entre peticiones. Mantener los IDs
  // evita buscar de nuevo la placa y la categoría para cada foto.
  const folderCache = new Map();

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

  function appFolderId() {
    if (!env.GOOGLE_DRIVE_APP_FOLDER_ID) {
      throw serviceError(
        'La carpeta madre Mi Taller APP no está configurada.',
        503
      );
    }
    return env.GOOGLE_DRIVE_APP_FOLDER_ID;
  }

  function configuredRootIds() {
    const ids = [
      env.GOOGLE_DRIVE_VEHICLE_FOLDER_ID,
      env.GOOGLE_DRIVE_INVOICE_FOLDER_ID,
      env.GOOGLE_DRIVE_APP_FOLDER_ID,
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

  function safeUploadRequestId(uploadRequestId) {
    if (uploadRequestId == null) return null;
    if (
      typeof uploadRequestId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(uploadRequestId)
    ) {
      throw serviceError('El identificador de la subida no es válido.', 400);
    }
    return uploadRequestId;
  }

  function safeAppProperties(appProperties) {
    if (appProperties == null) return {};
    if (typeof appProperties !== 'object' || Array.isArray(appProperties)) {
      throw serviceError('Las propiedades del archivo no son válidas.', 400);
    }
    const result = {};
    for (const [key, value] of Object.entries(appProperties)) {
      if (RESERVED_APP_PROPERTIES.has(key) || !/^[A-Za-z0-9_-]{1,100}$/.test(key) ||
          typeof value !== 'string' || !value || value.length > 124 ||
          /[\u0000-\u001f]/.test(value)) {
        throw serviceError('Las propiedades del archivo no son válidas.', 400);
      }
      result[key] = value;
    }
    return result;
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
      if (error.code === 'ECONNABORTED') {
        throw serviceError('Google Drive tardó demasiado en responder.', 504);
      }
      if (error.response?.status === 403) {
        const detail =
          error.response?.data?.error?.message ||
          error.response?.data?.error ||
          error.message;
        console.error('[Drive] Google rechazó la operación:', detail);
        throw serviceError(
          'Google Drive rechazó la operación. Verifica los permisos de la cuenta OAuth y de la carpeta configurada.',
          502
        );
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

  async function findWorkshopFolder(parentId, workshopId) {
    const escapedParent = escapeDriveQueryValue(parentId);
    const escapedWorkshop = escapeDriveQueryValue(workshopId);
    const response = await driveRequest({
      method: 'GET',
      url: `${DRIVE_API_URL}/files`,
      params: {
        q:
          `'${escapedParent}' in parents and ` +
          `mimeType = '${FOLDER_MIME_TYPE}' and ` +
          `appProperties has { key='${WORKSHOP_FOLDER_PROPERTY}' and value='${escapedWorkshop}' } and ` +
          'trashed = false',
        fields: 'files(id,name,appProperties)',
        pageSize: 1,
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });
    return response.data?.files?.[0] || null;
  }

  async function createFolder(parentId, name, appProperties) {
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
        ...(appProperties ? {appProperties} : {}),
      },
    });
    return response.data;
  }

  async function renameFolder(folderId, name) {
    const response = await driveRequest({
      method: 'PATCH',
      url: `${DRIVE_API_URL}/files/${folderId}`,
      params: {fields: 'id,name', supportsAllDrives: true},
      data: {name},
    });
    return response.data;
  }

  async function adoptWorkshopFolder(folderId, normalized) {
    const response = await driveRequest({
      method: 'PATCH',
      url: `${DRIVE_API_URL}/files/${folderId}`,
      params: {fields: 'id,name,appProperties', supportsAllDrives: true},
      data: {
        name: normalized.folderName,
        appProperties: {
          [WORKSHOP_FOLDER_PROPERTY]: normalized.id,
          vehicleAppManaged: 'true',
        },
      },
    });
    return response.data;
  }

  async function ensureFolderPath(rootId, folderPath) {
    let parentId = rootId;

    for (const segment of folderSegments(folderPath)) {
      const cacheKey = `${parentId}\u0000${segment}`;
      const cachedFolderId = folderCache.get(cacheKey);
      if (cachedFolderId) {
        parentId = cachedFolderId;
        continue;
      }

      const existing = await findFolder(parentId, segment);
      const folder = existing || (await createFolder(parentId, segment));
      if (!folder?.id) {
        throw new Error(`Google Drive no creó la carpeta "${segment}".`);
      }
      parentId = folder.id;
      folderCache.set(cacheKey, parentId);
    }

    return parentId;
  }

  async function ensureWorkshopStructure(workshop) {
    const normalized = normalizeWorkshop(workshop);
    const talleresId = await ensureFolderPath(appFolderId(), 'Talleres');
    let workshopFolder = await findWorkshopFolder(talleresId, normalized.id);
    if (!workshopFolder) {
      const legacyFolder =
        await findFolder(talleresId, `${normalized.name} · taller actual`) ||
        await findFolder(talleresId, normalized.name);
      workshopFolder = legacyFolder
        ? await adoptWorkshopFolder(legacyFolder.id, normalized)
        : await createFolder(talleresId, normalized.folderName, {
            [WORKSHOP_FOLDER_PROPERTY]: normalized.id,
            vehicleAppManaged: 'true',
          });
    } else if (workshopFolder.name !== normalized.folderName) {
      workshopFolder = await renameFolder(workshopFolder.id, normalized.folderName);
    }
    if (!workshopFolder?.id) {
      throw new Error('Google Drive no creó la carpeta del taller.');
    }

    const rootId = workshopFolder.id;
    const paths = {
      vehicles: 'Vehículos',
      customerInvoices: 'Facturación/Clientes/PDF',
      electronicInvoicePdf: 'Facturación/Electrónica/PDF',
      electronicInvoiceXml: 'Facturación/Electrónica/XML',
      supplierInvoices: 'Facturación/Proveedores',
      documents: 'Documentos',
      logos: 'Configuración/Logos',
      templates: 'Configuración/Plantillas',
      reports: 'Reportes',
    };
    const folderIds = {root: rootId};
    for (const [key, path] of Object.entries(paths)) {
      folderIds[key] = await ensureFolderPath(rootId, path);
    }
    return {
      workshopId: normalized.id,
      folderName: normalized.folderName,
      folderIds,
    };
  }

  async function workshopUploadTarget(workshop, root, folderPath) {
    const structure = await ensureWorkshopStructure(workshop);
    const segments = folderSegments(folderPath);
    if (root === 'vehicles') {
      return {
        rootId: structure.folderIds.vehicles,
        folderPath: `${segments[0]}/Fotos/${segments.slice(1).join('/')}`,
      };
    }
    if (root === 'invoices' && segments[1] === 'facturas_compras') {
      return {
        rootId: structure.folderIds.vehicles,
        folderPath: `${segments[0]}/Facturas de proveedores/${segments.slice(2).join('/')}`,
      };
    }
    if (root === 'invoices') {
      return {rootId: structure.folderIds.supplierInvoices, folderPath};
    }
    throw serviceError('Raíz de almacenamiento no permitida.', 400);
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
    uploadRequestId,
    appProperties,
    workshop,
  }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw serviceError('El contenido del archivo no es válido.', 400);
    }
    if (
      typeof mimeType !== 'string' ||
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
        mimeType
      )
    ) {
      throw serviceError('El tipo del archivo no es válido.', 400);
    }

    if (!['vehicles', 'invoices'].includes(root)) {
      throw serviceError('Raíz de almacenamiento no permitida.', 400);
    }
    const validatedFileName = safeFileName(fileName);
    const validatedRequestId = safeUploadRequestId(uploadRequestId);
    const validatedAppProperties = safeAppProperties(appProperties);
    const target = workshop
      ? await workshopUploadTarget(workshop, root, folderPath)
      : {rootId: rootFolderId(root), folderPath};
    const parentId = await ensureFolderPath(target.rootId, target.folderPath);
    if (validatedRequestId) {
      const query = [
        `'${escapeDriveQueryValue(parentId)}' in parents`,
        `appProperties has { key='uploadRequestId' and value='${escapeDriveQueryValue(validatedRequestId)}' }`,
        ...Object.entries(validatedAppProperties)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) =>
            `appProperties has { key='${escapeDriveQueryValue(key)}' and value='${escapeDriveQueryValue(value)}' }`),
        'trashed = false',
      ].join(' and ');
      const existing = await driveRequest({
        method: 'GET',
        url: `${DRIVE_API_URL}/files`,
        params: {
          q: query,
          fields: 'files(id,name,mimeType,size,parents)',
          pageSize: 1,
          spaces: 'drive',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      });
      if (existing.data?.files?.[0]) return existing.data.files[0];
    }
    const metadata = {
      name: validatedFileName,
      parents: [parentId],
      appProperties: {
        ...validatedAppProperties,
        vehicleAppManaged: 'true',
        storageRoot: root,
        ...(validatedRequestId
          ? {uploadRequestId: validatedRequestId}
          : {}),
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
        fields: 'id,mimeType,parents,trashed,appProperties',
        supportsAllDrives: true,
      },
    });
  }

  // Custom properties identify who uploaded a managed file. The platform uses
  // them to keep a workshop from reading or deleting another workshop's photos.
  async function fileAppProperties(fileId) {
    const id = safeFileId(fileId);
    const response = await fileMetadata(id);
    if (response.data?.trashed) {
      const error = serviceError('Archivo no encontrado.', 404);
      error.response = {status: 404};
      throw error;
    }
    return response.data?.appProperties || {};
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
    fileAppProperties,
    ensureWorkshopStructure,
  };
}

const driveService = createDriveService();

module.exports = {
  ...driveService,
  createDriveService,
  vehiclePhotoFolderPath,
  workshopFileName,
  WORKSHOP_FOLDER_PROPERTY,
};
