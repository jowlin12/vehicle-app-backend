const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const test = require('node:test');
const {
  createDriveService,
  vehiclePhotoFolderPath,
  workshopFileName,
} = require('./drive-service.js');

function testEnvironment() {
  return {
    GOOGLE_DRIVE_CLIENT_ID: 'client-id',
    GOOGLE_DRIVE_CLIENT_SECRET: 'client-secret',
    GOOGLE_DRIVE_REFRESH_TOKEN: 'refresh-token',
    GOOGLE_DRIVE_VEHICLE_FOLDER_ID: 'vehicle-root',
    GOOGLE_DRIVE_INVOICE_FOLDER_ID: 'invoice-root',
    GOOGLE_DRIVE_APP_FOLDER_ID: 'app-root',
  };
}

test('organiza las fotos por placa y categoría como en Drive', () => {
  assert.equal(
    vehiclePhotoFolderPath('a01-a6e', ' Frontal '),
    'A01A6E/frontal'
  );
  assert.equal(
    vehiclePhotoFolderPath('A01AA6E', 'cojines'),
    'A01AA6E/cojines'
  );
  assert.throws(
    () => vehiclePhotoFolderPath('ABC123', 'documentos'),
    error => error.statusCode === 400
  );
  assert.throws(
    () => vehiclePhotoFolderPath('../', 'motor'),
    error => error.statusCode === 400
  );
});

test('crea la ruta y sube el archivo privado con OAuth', async () => {
  const calls = [];
  let folderNumber = 0;
  const httpClient = {
    async post(url, body) {
      assert.match(url, /oauth2\.googleapis\.com\/token$/);
      assert.match(body, /grant_type=refresh_token/);
      return {data: {access_token: 'access-token', expires_in: 3600}};
    },
    async request(options) {
      calls.push(options);
      assert.equal(options.headers.Authorization, 'Bearer access-token');

      if (options.method === 'GET' && options.url.endsWith('/files')) {
        return {data: {files: []}};
      }
      if (
        options.method === 'POST' &&
        options.url.includes('/upload/drive/v3/files')
      ) {
        assert.equal(options.params.uploadType, 'multipart');
        assert.ok(Buffer.isBuffer(options.data));
        assert.match(options.data.toString(), /"vehicleAppManaged":"true"/);
        assert.match(options.data.toString(), /(?:private|second)-image\.jpg/);
        return {data: {id: 'uploaded-file', name: 'private-image.jpg'}};
      }
      if (options.method === 'POST' && options.url.endsWith('/drive/v3/files')) {
        folderNumber += 1;
        return {data: {id: `folder-${folderNumber}`, name: options.data.name}};
      }
      throw new Error(`Llamada inesperada: ${options.method} ${options.url}`);
    },
  };
  const service = createDriveService(httpClient, testEnvironment());

  const result = await service.uploadPrivateFile({
    buffer: Buffer.from('image-content'),
    fileName: 'private-image.jpg',
    mimeType: 'image/jpeg',
    folderPath: 'ABC123/externas',
    root: 'vehicles',
  });

  assert.equal(result.id, 'uploaded-file');
  assert.equal(folderNumber, 2);
  assert.equal(
    calls.filter(call => call.url.endsWith('/files') && call.method === 'GET').length,
    2
  );

  await service.uploadPrivateFile({
    buffer: Buffer.from('second-image'),
    fileName: 'second-image.jpg',
    mimeType: 'image/jpeg',
    folderPath: 'ABC123/externas',
    root: 'vehicles',
  });
  assert.equal(
    calls.filter(call => call.url.endsWith('/files') && call.method === 'GET').length,
    2
  );
});

test('reutiliza la foto creada cuando se reintenta la misma subida', async () => {
  let uploadCalls = 0;
  const httpClient = {
    async post() {
      return {data: {access_token: 'access-token', expires_in: 3600}};
    },
    async request(options) {
      if (options.method === 'GET' && options.url.endsWith('/files')) {
        if (options.params.q.includes('appProperties')) {
          assert.match(options.params.q, /upload-request-123/);
          assert.match(options.params.q, /vehicleAppWorkshop/);
          assert.match(options.params.q, /workshop-a/);
          return {data: {files: [{id: 'existing-photo', name: 'image.jpg'}]}};
        }
        return {data: {files: [{id: 'existing-folder', name: 'folder'}]}};
      }
      if (options.url.includes('/upload/drive/v3/files')) {
        uploadCalls += 1;
      }
      throw new Error(`Llamada inesperada: ${options.method} ${options.url}`);
    },
  };
  const service = createDriveService(httpClient, testEnvironment());

  const result = await service.uploadPrivateFile({
    buffer: Buffer.from('image-content'),
    fileName: 'image.jpg',
    mimeType: 'image/jpeg',
    folderPath: 'ABC123/frontal',
    root: 'vehicles',
    uploadRequestId: 'upload-request-123',
    appProperties: {vehicleAppWorkshop: 'workshop-a'},
  });

  assert.equal(result.id, 'existing-photo');
  assert.equal(uploadCalls, 0);
});

test('genera nombres legibles y únicos para fotos y facturas de proveedor', () => {
  const now = new Date('2026-09-15T18:42:31.000Z');
  assert.equal(workshopFileName({
    root: 'vehicles',
    folderPath: 'abc-123/frontal',
    mimeType: 'image/jpeg',
    uploadRequestId: 'request-0001',
    now,
  }), 'foto_ABC123_frontal_20260915T184231Z_request-0001.jpg');
  assert.equal(workshopFileName({
    root: 'invoices',
    folderPath: 'ABC123/facturas_compras/Repuestos Gómez',
    mimeType: 'application/pdf',
    uploadRequestId: 'invoice-0002',
    now,
  }), 'factura-proveedor_ABC123_repuestos-gomez_20260915T184231Z_invoice-0002.pdf');
});

test('crea la estructura completa de un taller bajo Mi Taller APP', async () => {
  const created = [];
  let sequence = 0;
  const httpClient = {
    async post() {
      return {data: {access_token: 'access-token', expires_in: 3600}};
    },
    async request(options) {
      if (options.method === 'GET' && options.url.endsWith('/files')) {
        return {data: {files: []}};
      }
      if (options.method === 'POST' && options.url.endsWith('/drive/v3/files')) {
        sequence += 1;
        created.push(options.data);
        return {data: {id: `folder-${sequence}`, name: options.data.name}};
      }
      throw new Error(`Llamada inesperada: ${options.method} ${options.url}`);
    },
  };
  const service = createDriveService(httpClient, testEnvironment());
  const workshopId = '80000000-0000-4000-8000-000000000001';
  const structure = await service.ensureWorkshopStructure({id: workshopId, name: 'Taller Norte'});

  assert.equal(structure.workshopId, workshopId);
  assert.equal(structure.folderName, 'Taller Norte · 80000000');
  assert.deepEqual(created[0], {
    name: 'Talleres',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['app-root'],
  });
  assert.deepEqual(created[1].appProperties, {
    vehicleAppWorkshopFolder: workshopId,
    vehicleAppManaged: 'true',
  });
  for (const expected of [
    'Vehículos', 'Facturación', 'Clientes', 'PDF', 'Electrónica', 'XML',
    'Proveedores', 'Documentos', 'Configuración', 'Logos', 'Plantillas', 'Reportes',
  ]) {
    assert.ok(created.some(folder => folder.name === expected), expected);
  }
});

test('adopta la carpeta migrada del taller actual sin duplicarla', async () => {
  const patches = [];
  let sequence = 0;
  const httpClient = {
    async post() {
      return {data: {access_token: 'access-token', expires_in: 3600}};
    },
    async request(options) {
      if (options.method === 'GET' && options.url.endsWith('/files')) {
        if (options.params.q.includes("name = 'Talleres'")) {
          return {data: {files: [{id: 'talleres', name: 'Talleres'}]}};
        }
        if (options.params.q.includes('appProperties has')) return {data: {files: []}};
        if (options.params.q.includes("name = 'Mazos Car · taller actual'")) {
          return {data: {files: [{id: 'legacy-workshop', name: 'Mazos Car · taller actual'}]}};
        }
        return {data: {files: []}};
      }
      if (options.method === 'PATCH') {
        patches.push(options);
        return {data: {id: 'legacy-workshop', name: options.data.name}};
      }
      if (options.method === 'POST' && options.url.endsWith('/drive/v3/files')) {
        sequence += 1;
        return {data: {id: `folder-${sequence}`, name: options.data.name}};
      }
      throw new Error(`Llamada inesperada: ${options.method} ${options.url}`);
    },
  };
  const service = createDriveService(httpClient, testEnvironment());
  const id = '80000000-0000-4000-8000-000000000001';
  const result = await service.ensureWorkshopStructure({id, name: 'Mazos Car'});

  assert.equal(result.folderIds.root, 'legacy-workshop');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].data.name, 'Mazos Car · 80000000');
  assert.deepEqual(patches[0].data.appProperties, {
    vehicleAppWorkshopFolder: id,
    vehicleAppManaged: 'true',
  });
});

test('rechaza propiedades que podrían reemplazar el alcance administrado', async () => {
  let networkCalls = 0;
  const httpClient = {
    async post() { networkCalls += 1; },
    async request() { networkCalls += 1; },
  };
  const service = createDriveService(httpClient, testEnvironment());
  await assert.rejects(service.uploadPrivateFile({
    buffer: Buffer.from('image-content'),
    fileName: 'image.jpg',
    mimeType: 'image/jpeg',
    folderPath: 'ABC123/frontal',
    root: 'vehicles',
    appProperties: {uploadRequestId: 'foreign-scope'},
  }), error => error.statusCode === 400);
  assert.equal(networkCalls, 0);
});

test('solo descarga y elimina archivos ubicados bajo una raíz configurada', async () => {
  const mediaStream = Readable.from(['image']);
  const calls = [];
  const parents = new Map([
    ['uploaded-file', ['nested-folder']],
    ['nested-folder', ['vehicle-root']],
  ]);
  const httpClient = {
    async post() {
      return {data: {access_token: 'access-token', expires_in: 3600}};
    },
    async request(options) {
      calls.push(options);
      const fileId = options.url.split('/').pop();

      if (options.method === 'GET' && options.params?.fields) {
        return {
          data: {
            id: fileId,
            parents: parents.get(fileId) || [],
            trashed: false,
          },
        };
      }
      if (options.method === 'GET' && options.params?.alt === 'media') {
        return {
          data: mediaStream,
          headers: {'content-type': 'image/jpeg'},
        };
      }
      if (options.method === 'DELETE') {
        return {status: 204};
      }
      throw new Error(`Llamada inesperada: ${options.method} ${options.url}`);
    },
  };
  const service = createDriveService(httpClient, testEnvironment());

  const download = await service.downloadPrivateFile('uploaded-file');
  assert.equal(download.headers['content-type'], 'image/jpeg');
  await service.deletePrivateFile('uploaded-file');

  assert.equal(calls.filter(call => call.params?.alt === 'media').length, 1);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('rechaza raíces, rutas e identificadores no permitidos antes de llamar a Google', async () => {
  let networkCalls = 0;
  const httpClient = {
    async post() {
      networkCalls += 1;
      throw new Error('No debería llamar a OAuth');
    },
    async request() {
      networkCalls += 1;
      throw new Error('No debería llamar a Drive');
    },
  };
  const service = createDriveService(httpClient, testEnvironment());
  const baseUpload = {
    buffer: Buffer.from('image'),
    fileName: 'image.jpg',
    mimeType: 'image/jpeg',
    folderPath: 'ABC123/externas',
    root: 'vehicles',
  };

  await assert.rejects(
    service.uploadPrivateFile({...baseUpload, root: 'other'}),
    error => error.statusCode === 400
  );
  await assert.rejects(
    service.uploadPrivateFile({...baseUpload, folderPath: '../externas'}),
    error => error.statusCode === 400
  );
  await assert.rejects(
    service.downloadPrivateFile('../secret'),
    error => error.statusCode === 400
  );
  assert.equal(networkCalls, 0);
});

test('convierte errores de permisos y timeout de Google en respuestas útiles', async () => {
  const environment = testEnvironment();

  for (const expected of [
    {
      failure: {
        response: {
          status: 403,
          data: {error: {message: 'Insufficient permissions'}},
        },
      },
      statusCode: 502,
      message: /permisos/i,
    },
    {
      failure: {code: 'ECONNABORTED'},
      statusCode: 504,
      message: /tardó demasiado/i,
    },
  ]) {
    const httpClient = {
      async post() {
        return {data: {access_token: 'access-token', expires_in: 3600}};
      },
      async request() {
        throw failureAsError(expected.failure);
      },
    };
    const service = createDriveService(httpClient, environment);

    await assert.rejects(
      service.uploadPrivateFile({
        buffer: Buffer.from('image'),
        fileName: 'image.jpg',
        mimeType: 'image/jpeg',
        folderPath: 'ABC123/frontal',
        root: 'vehicles',
      }),
      error =>
        error.statusCode === expected.statusCode &&
        expected.message.test(error.message)
    );
  }
});

function failureAsError(values) {
  return Object.assign(new Error('Google request failed'), values);
}
