const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const test = require('node:test');
const {
  createDriveService,
  vehiclePhotoFolderPath,
} = require('./drive-service.js');

function testEnvironment() {
  return {
    GOOGLE_DRIVE_CLIENT_ID: 'client-id',
    GOOGLE_DRIVE_CLIENT_SECRET: 'client-secret',
    GOOGLE_DRIVE_REFRESH_TOKEN: 'refresh-token',
    GOOGLE_DRIVE_VEHICLE_FOLDER_ID: 'vehicle-root',
    GOOGLE_DRIVE_INVOICE_FOLDER_ID: 'invoice-root',
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
