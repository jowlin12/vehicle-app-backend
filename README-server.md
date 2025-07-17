"# VehicleApp

Esta es una aplicación full-stack diseñada para gestionar los servicios, reparaciones y facturación de vehículos para un taller mecánico. El proyecto consiste en un backend de Node.js con un servidor Express.js y una aplicación móvil basada en Flutter para el frontend.

## Tabla de Contenidos

- [Características](#características)
- [Tecnologías Utilizadas](#tecnologías-utilizadas)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Configuración e Instalación](#configuración-e-instalación)
  - [Backend](#configuración-del-backend)
  - [Frontend (Flutter)](#configuración-de-la-app-flutter)
- [Variables de Entorno](#variables-de-entorno)
- [Documentación Técnica Detallada](#documentación-técnica-detallada)
  - [1. Arquitectura y Base de Datos](#1-arquitectura-y-base-de-datos-supabase)
  - [2. Arquitectura del Frontend](#2-arquitectura-del-frontend-flutter)
  - [3. Flujos de Lógica de Negocio Clave](#3-flujos-de-lógica-de-negocio-clave)
  - [4. Arquitectura y Decisiones de Diseño](#4-arquitectura-y-decisiones-de-diseño)
  - [5. Componentes Clave y Lógica Detallada](#5-componentes-clave-y-lógica-detallada)
  - [6. Funcionalidades de Administrador](#6-funcionalidades-de-administrador)
  - [7. Configuración del Backend y Seguridad](#7-configuración-del-backend-y-seguridad)
- [Endpoints de la API (Detallado)](#endpoints-de-la-api-detallado)

## Características

### Backend

- **Generación de Facturas**: Genera dinámicamente facturas en PDF a partir de los datos del formato y repuestos usando una API propia.
- **Gestión de Trabajadores**: Permite la creación y configuración de cuentas para los trabajadores.
- **Integración con Supabase**: Utiliza Supabase para los servicios de base de datos y autenticación.
- **Almacenamiento en Google Drive**: Los PDFs generados se almacenan automáticamente en Google Drive.

### Frontend

- **Autenticación de Usuarios**: Inicio de sesión seguro para administradores y trabajadores.
- **Panel de Control (Dashboard)**: Proporciona una visión general de las métricas y operaciones clave.
- **Gestión de Formatos**: Crear, ver y editar formatos de servicio y reparación.
- **Gestión de Facturas**: Ver y gestionar las facturas generadas.
- **Gestión de Vehículos y Clientes**: Mantener un registro de la información de clientes y vehículos.

## Tecnologías Utilizadas

- **Backend**: Node.js, Express.js
- **Frontend**: Flutter
- **Base de Datos**: Supabase (PostgreSQL)
- **Generación de PDF**: API propia (HTML a PDF con almacenamiento en Google Drive)
- **Despliegue**: Vercel (para el backend)

## Estructura del Proyecto

```
/Server
|-- /vehicle_flutter/client   # Aplicación frontend de Flutter
|-- index.js                  # Archivo principal del servidor backend
|-- database.js               # Configuración del cliente de Supabase
|-- package.json              # Dependencias del backend
|-- vercel.json               # Configuración de despliegue de Vercel
|-- invoice-template.html     # Plantilla Handlebars para las facturas
```

## Configuración del Backend (local, No utilizado)

1.  **Instalar Dependencias**: Navega al directorio `Server` y ejecuta:
    ```bash
    npm install
    ```

2.  **Ejecutar el Servidor**: Inicia el servidor backend con:
    ```bash
    npm start
    ```

El servidor se ejecutará en `http://localhost:5000`.

## Endpoints de la API (Detallado)

### `POST /api/generate-invoice`

Genera una factura en PDF usando una API propia, la almacena automáticamente en Google Drive y actualiza la base de datos con la URL del documento.

- **Protección**: Requiere autenticación.
- **Cuerpo de la Solicitud (Request Body)**:
  ```json
  {
    "formato": {
      "clave_key": "F-001",
      "nombre_cliente": "Juan Pérez",
      "placa": "XYZ123"
    },
    "repuestos": [
      {
        "cantidad": 2,
        "descripcion": "Filtro de Aceite",
        "costo_unitario": 15000
      }
    ],
    "servicios": [
      {
        "descripcion": "Cambio de aceite"
      }
    ],
    "costos": {
      "subtotal": 30000,
      "iva": 5700,
      "total": 35700
    }
  }
  ```
- **Respuesta Exitosa (200 OK)**:
  ```json
  {
    "invoiceUrl": "https://drive.google.com/file/d/[FILE_ID]/view"
  }
  ```
- **Respuesta de Error (500 Internal Server Error)**:
  ```json
  {
    "error": "Error al generar la factura con la API propia: [Mensaje del error]"
  }
  ```

### `POST /api/workers`

Crea una nueva cuenta de trabajador con un email y contraseña temporales.

- **Protección**: Requiere autenticación y rol de administrador.
- **Cuerpo de la Solicitud (Request Body)**:
  ```json
  {
    "full_name": "Ana Gómez"
  }
  ```
- **Respuesta Exitosa (201 Created)**:
  ```json
  {
    "username": "ana123",
    "temporal_password": "temp_password_xyz"
  }
  ```
- **Respuesta de Error (400 Bad Request / 500 Internal Server Error)**:
  ```json
  {
    "error": "[Mensaje del error]"
  }
  ```

### `PUT /api/workers/me/setup`

Permite a un trabajador que inicia sesión por primera vez establecer su email y contraseña definitivos.

- **Protección**: Requiere autenticación del propio usuario.
- **Cuerpo de la Solicitud (Request Body)**:
  ```json
  {
    "email": "ana.gomez@email.com",
    "password": "nueva_contraseña_segura"
  }
  ```
- **Respuesta Exitosa (200 OK)**:
  ```json
  {
    "message": "Usuario actualizado correctamente."
  }
  ```
- **Respuesta de Error (401 Unauthorized / 500 Internal Server Error)**:
  ```json
  {
    "error": "[Mensaje del error]"
  }
  ```

## Configuración de la App Flutter

1.  **Navega al directorio del cliente**:
    ```bash
    cd vehicle_flutter/client
    ```

2.  **Instalar Dependencias**:
    ```bash
    flutter pub get
    ```

3.  **Ejecutar la App**:
    ```bash
    flutter run
    ```

## Variables de Entorno

Las siguientes variables de entorno son necesarias para que el backend funcione correctamente:

- `SUPABASE_URL`: La URL de tu proyecto de Supabase.
- `SUPABASE_ANON_KEY`: La clave anónima de tu proyecto de Supabase.

**Nota**: Ya no se requiere `PDFSHIFT_API_KEY` ya que ahora se usa una API propia para la generación de PDFs.

---

## Documentación Técnica Detallada

### 1. Arquitectura y Base de Datos (Supabase)

La base de datos en Supabase es el núcleo del sistema y almacena toda la información operativa. Las tablas principales son:

- **`profiles`**: Almacena los perfiles de los usuarios (trabajadores). Se vincula con la tabla `auth.users` de Supabase a través del `id`.
  - `id` (UUID, FK a `auth.users.id`): Identificador único del usuario.
  - `full_name` (text): Nombre completo del trabajador.
  - `username` (text): Nombre de usuario para el login.
  - `must_change_password` (boolean): Flag que obliga al usuario a cambiar su contraseña en el primer inicio de sesión.

- **`formatos`**: Contiene la información de cada orden de servicio o cotización.
  - `id` (int8, PK): Identificador numérico.
  - `clave_key` (text, Unique): Folio único del formato (ej. `F-001`).
  - `nombre_cliente`, `placa`, `marca`, `tipo_vehiculo`, `kilometraje`, `observaciones`: Datos del cliente y del vehículo.
  - `url_documento` (text): URL del PDF de la factura/cotización generada.

- **`repuestos`**: Detalla los repuestos utilizados en un formato.
  - `id` (int8, PK): Identificador único.
  - `id_repuesto` (text, FK a `formatos.folio`): Vincula el repuesto al formato correspondiente.
  - `descripcion` (text): Nombre del repuesto.
  - `cantidad` (int4): Cantidad utilizada.
  - `costo_unitario` (float8): Precio por unidad.

- **`servicios`**: Detalla los servicios realizados en un formato.
  - `id` (int8, PK): Identificador único.
  - `formato_folio` (text, FK a `formatos.folio`): Vincula el servicio al formato.
  - `descripcion` (text): Descripción del servicio.

- **`facturas`**: Almacena el registro de las facturas generadas.
  - `id` (int8, PK): Identificador único.
  - `id_formato` (text, FK a `formatos.folio`): Vincula la factura a un formato.
  - `precio_factura` (float8): Monto total de la factura.
  - `debe` (float8): Saldo pendiente.
  - `estado` (text): Estado de la factura (ej. `PENDIENTE`, `PAGADA`).
  - `factura_pdf` (text): URL pública del documento PDF en Supabase Storage.

### 2. Arquitectura del Frontend (Flutter)

La aplicación móvil está estructurada en tres capas principales dentro del directorio `lib`:

- **`/models`**: Contiene las clases de Dart que mapean las tablas de la base de datos (ej. `formato.dart`, `repuesto.dart`, `factura.dart`). Esto permite manejar los datos de forma tipada en la aplicación.

- **`/services`**: Centraliza la comunicación con el backend y Supabase. Cada servicio es responsable de un área específica:
  - `factura_service.dart`: Gestiona la creación y obtención de facturas.
  - `repuesto_service.dart`, `servicio_service.dart`: Manejan la lógica para obtener y modificar repuestos y servicios.
  - `download_service.dart`: Proporciona la funcionalidad para descargar los archivos PDF.

- **`/screens`**: Contiene los widgets que construyen la interfaz de usuario de cada pantalla de la aplicación:
  - `login_screen.dart`: Pantalla de inicio de sesión.
  - `dashboard_screen.dart`: Panel principal para los trabajadores.
  - `admin_panel_screen.dart`: Panel de administración con funciones adicionales.
  - `formats_screen.dart`: Muestra la lista de formatos de servicio.
  - `format_detail_screen.dart`: Muestra los detalles de un formato, permitiendo añadir repuestos/servicios y generar la factura.
  - `new_format_screen.dart`: Formulario para crear una nueva orden de servicio.
  - `invoices_screen.dart`: Muestra la lista de facturas generadas.

### 3. Flujos de Lógica de Negocio Clave

#### Flujo de Generación de Facturas

1.  **Usuario (Flutter)**: Desde `format_detail_screen.dart`, el usuario presiona el botón "Generar Factura".
2.  **Llamada al Servicio (Flutter)**: La app recopila los datos del formato, repuestos y servicios y llama a `factura_service.generateInvoice()`.
3.  **Petición al Backend (Node.js)**: El servicio realiza una petición `POST` al endpoint `/api/generate-invoice` del backend, enviando todos los datos en formato JSON.
4.  **Procesamiento en Backend**: 
    a. El servidor recibe los datos.
    b. Formatea los costos a un formato de moneda local (COP).
    c. Compila una plantilla HTML (`invoice-template.html`) con los datos usando Handlebars.
    d. Envía el HTML resultante a la API de PDFShift para convertirlo en un PDF.
5.  **Almacenamiento en Supabase**: 
    a. El backend recibe el buffer del PDF y lo sube a Supabase Storage en el bucket `invoices`.
    b. Crea o actualiza el registro correspondiente en la tabla `facturas` con la URL pública del PDF y el total.
    c. Actualiza la tabla `formatos` con la URL del documento.
6.  **Respuesta al Frontend**: El backend devuelve la URL pública del PDF a la aplicación Flutter, que la muestra o permite al usuario descargarla.

#### Flujo de Creación y Configuración de Trabajadores

1.  **Administrador (Flutter)**: Desde `admin_panel_screen.dart`, el administrador crea un nuevo trabajador proporcionando su nombre completo.
2.  **Petición al Backend**: La app llama al endpoint `POST /api/workers`.
3.  **Creación en Backend**:
    a. El servidor genera un email y una contraseña temporal únicos.
    b. Crea el usuario en `Supabase Auth` usando las credenciales temporales.
    c. Actualiza la tabla `profiles` con el `full_name`, un `username` generado y el flag `must_change_password` a `true`.
    d. Devuelve el `username` y la `temporal_password` al administrador para que los comparta con el nuevo trabajador.
4.  **Primer Inicio de Sesión (Flutter)**:
    a. El nuevo trabajador inicia sesión con sus credenciales temporales en `login_screen.dart`.
    b. La aplicación detecta que `must_change_password` es `true` y lo redirige a `change_password_screen.dart`.
5.  **Configuración de Cuenta**: 
    a. El trabajador ingresa su nuevo email y contraseña.
    b. La app envía esta información al endpoint `PUT /api/workers/me/setup` junto con el token de sesión.
6.  **Actualización en Backend**:
    a. El servidor valida el token, actualiza el email y la contraseña del usuario en `Supabase Auth`.
    b. Cambia el flag `must_change_password` a `false` en la tabla `profiles`.
7.  **Finalización**: El trabajador es redirigido al `dashboard_screen.dart` y puede usar la aplicación normalmente.

### 4. Arquitectura y Decisiones de Diseño

#### Arquitectura Frontend (Flutter)

La aplicación Flutter está estructurada siguiendo un enfoque pragmático y mantenible:

- **Gestión de Estado**: La arquitectura se basa en el uso de `StatefulWidget` y el método `setState` para la gestión del estado de la UI. Esta decisión evita la sobrecarga de librerías externas de gestión de estado (como Provider o BLoC), resultando en un código más directo y fácil de seguir para las funcionalidades implementadas.
- **Separación de Lógica**: La lógica de negocio está claramente separada de la UI. Los `services` se encargan de todas las comunicaciones con la API y la base de datos, los `models` definen la estructura de los datos, y las `screens` se centran en la presentación.
- **Dependencias Clave** (`pubspec.yaml`):
  - `supabase_flutter`: Para la interacción directa con la base de datos y la autenticación.
  - `http`: Para la comunicación con los endpoints personalizados del backend (ej. generación de facturas).
  - `intl`: Para el formateo de fechas y números, garantizando una UI consistente.
  - `uuid`: Para la generación de identificadores únicos en el lado del cliente.
  - `permission_handler`, `path_provider`, `open_file`: Un conjunto de paquetes para gestionar descargas y permisos, ofreciendo una experiencia de usuario fluida al manejar archivos.

#### Flujo de Generación de Facturas (Backend)

El endpoint `POST /api/generate-invoice` es uno de los más críticos y robustos del sistema. Orquesta un proceso complejo:

1.  **Recepción de Datos**: Recibe un objeto JSON completo con los datos del formato, listas de repuestos, servicios y costos.
2.  **Compilación de Plantilla**: Utiliza la librería `Handlebars` para inyectar dinámicamente los datos en una plantilla HTML predefinida. Esto incluye la generación de filas de tablas para cada repuesto y servicio.
3.  **Conversión a PDF**: Envía el HTML resultante a la API externa **PDFShift**, que lo convierte en un documento PDF profesional.
4.  **Almacenamiento en la Nube**: El PDF (en formato `arraybuffer`) se sube a un bucket de **Supabase Storage** llamado `invoices`.
5.  **Generación de URL Pública**: Se obtiene una URL pública para el archivo recién subido. Se le añade un parámetro de timestamp (`?t=...`) para evitar problemas de caché si la factura se regenera.
6.  **Actualización de la Base de Datos**: Se realiza una operación `upsert` en la tabla `facturas` (crea la factura si no existe, o la actualiza si ya existía) y se guarda la URL del PDF en la tabla `formatos`.
7.  **Respuesta al Cliente**: Devuelve la URL pública del PDF al cliente Flutter para que pueda ser mostrada o descargada.

### 5. Componentes Clave y Lógica Detallada

#### Lógica de Invalidación de Facturas (`FormatDetailScreen`)

Para garantizar la integridad de los datos y evitar que se envíen cotizaciones incorrectas a los clientes, la pantalla de detalles del formato implementa una lógica de "invalidación" inteligente:

- **Disparador**: Cada vez que el usuario añade, edita o elimina un repuesto o un servicio, se activa esta lógica.
- **Acción**: La función `_invalidateInvoice` se ejecuta, realizando dos acciones clave en la UI:
  1.  Establece un flag interno (`_isDataModified = true`).
  2.  Oculta inmediatamente el botón para ver/descargar la factura existente (`_invoiceUrl = null`).
- **Resultado**: El usuario recibe una notificación visual (un `SnackBar`) indicando que los datos han cambiado y debe generar una nueva factura. Esto le obliga a hacer clic en el botón "Generar Factura" de nuevo, que ejecutará el flujo del backend y creará un PDF actualizado, asegurando que la información es siempre la más reciente.

Esta sección profundiza en componentes específicos que son fundamentales para la funcionalidad y la experiencia de usuario de la aplicación.

#### Seguridad del Backend: Middleware `protect`

El archivo `middleware.js` contiene una función de middleware esencial llamada `protect`. 

- **Función**: Intercepta las peticiones a rutas protegidas para verificar que incluyan un token de autenticación (JWT) válido en el header `Authorization`.
- **Proceso**: 
  1. Extrae el token `Bearer` del header.
  2. Utiliza `supabase.auth.getUser(token)` para validar el token contra Supabase.
  3. Si el token es válido, adjunta la información del usuario (`req.user`) al objeto de la petición para que pueda ser utilizado por los controladores de las rutas.
  4. Si el token es inválido o no se proporciona, devuelve un error `401 No Autorizado`, denegando el acceso.

#### Widget Interactivo: `AddRepuestoDialog`

Este no es un simple diálogo, sino un componente complejo y reutilizable (`/widgets/add_repuesto_dialog.dart`) que encapsula una gran parte de la lógica de negocio para la gestión de repuestos.

- **Búsqueda Inteligente**: 
  - Permite buscar repuestos en el catálogo (`catalogo_repuestos`) por nombre o ID.
  - Implementa un `Timer` (debounce) de 400ms para evitar realizar búsquedas en la base de datos con cada tecla presionada, mejorando el rendimiento.
- **Gestión del Catálogo**: 
  - Si un repuesto no se encuentra, el usuario puede añadirlo al catálogo directamente desde el diálogo sin salir de la pantalla actual.
  - Permite eliminar repuestos del catálogo con un diálogo de confirmación.
- **Cálculo de Costos en Tiempo Real**: El costo total de la línea (`cantidad * costo_unitario`) se calcula y actualiza en la UI instantáneamente mientras el usuario introduce los datos.
- **Origen del Repuesto**: Incluye un `SegmentedButton` para especificar si el repuesto fue traído por el 'Taller' o por el 'Cliente', un dato de negocio importante.
- **Validación de Formulario**: Asegura que todos los campos necesarios estén completos y que se haya seleccionado un repuesto válido de la lista antes de permitir guardar.

### 5. Lógica de Servicios y Modelos de Datos

#### `FacturaService`: Orquestación de la Lógica de Facturación

El `FacturaService` (`/services/factura_service.dart`) es el cerebro detrás de toda la gestión de facturas y abonos. Su diseño robusto garantiza la integridad de los datos financieros.

- **Operaciones Atómicas con RPC de Supabase**: Para operaciones críticas como registrar un abono o eliminar una factura, el servicio no ejecuta múltiples comandos SQL por separado. En su lugar, invoca **Funciones de Procedimiento Remoto (RPC)** en la base de datos de Supabase (`registrar_abono_y_actualizar_factura`, `eliminar_abono_y_actualizar_factura`). Esto garantiza la **atomicidad**: la serie de operaciones (ej. crear el abono Y actualizar el saldo de la factura) se completa como una única transacción indivisible. O todo tiene éxito, o todo falla, eliminando el riesgo de inconsistencias en los datos.

- **Ciclo de Vida Completo**: Gestiona todo el flujo de una factura:
  - `crearOActualizarFactura`: Evita duplicados. Si una factura para un formato ya existe, la actualiza; si no, la crea.
  - `updateFacturaStatus`: Modifica el estado de la factura (ej. de 'PENDIENTE' a 'PAGADO').
  - `generateInvoice`: Compila todos los datos necesarios (formato, repuestos, servicios, costos) y los envía al endpoint del backend `/api/generate-invoice` para generar el PDF.

#### `Formato`: El Modelo de Datos Central

El modelo `Formato` (`/models/formato.dart`) es la estructura de datos más importante de la aplicación. Representa una orden de servicio o cotización y contiene toda la información del vehículo, cliente, costos y estado del trabajo.

- **Constructor `fromJson` Robusto**: El método de fábrica `Formato.fromJson` está diseñado para ser resiliente. Maneja de forma segura posibles valores nulos y realiza las conversiones de tipo necesarias (ej. de `String` a `double`), evitando que la aplicación falle si los datos de la API no son perfectos.
- **Inmutabilidad con `copyWith`**: La presencia del método `copyWith` es una buena práctica en Flutter. Permite crear una copia de un objeto `Formato` con modificaciones, lo que facilita la gestión del estado de una manera predecible y segura, sin mutar los objetos originales.

#### Lógica de Generación de Folio (`clave_key`) en el Backend

La creación de un nuevo formato (`new_format_screen.dart`) desencadena una lógica importante en el backend para asignar un folio único y secuencial.

- **Disparador**: Cuando se crea una nueva orden de servicio en la app.
- **Proceso en el Backend** (`index.js`):
  1.  Antes de insertar el nuevo formato, el servidor realiza una consulta a la tabla `formatos` para obtener el valor máximo actual de `folio`.
  2.  Incrementa este valor en `1` para obtener el nuevo número secuencial.
  3.  Construye el `clave_key` formateado, por ejemplo, `F-00<nuevo_numero>`.
  4.  Inserta el nuevo registro del formato en la base de datos con este `folio` y `clave_key` únicos, garantizando que no haya duplicados y se mantenga una secuencia ordenada.

#### Gestión de Abonos y Estado de Cuenta (`FacturaService`)

La aplicación permite un manejo detallado de los pagos parciales (abonos) sobre una factura, asegurando la integridad de los datos financieros mediante el uso de funciones RPC de Supabase.

- **Componente UI**: En `format_detail_screen.dart`, un diálogo permite registrar un nuevo abono.
- **Lógica de Servicio (`FacturaService`)**:
  1.  **Invocación de RPC**: En lugar de realizar múltiples llamadas a la base de datos (una para insertar el abono, otra para actualizar la factura), se invoca una única función RPC en Supabase llamada `registrar_abono_y_actualizar_factura`.
  2.  **Atomicidad**: Esta función se ejecuta como una transacción atómica en la base de datos. Recibe el `id_formato` y el `monto_abono`, y realiza dos operaciones:
      a. Inserta un nuevo registro en la tabla `abonos`.
      b. Actualiza el campo `debe` en la tabla `facturas`, restando el monto del abono.
  3.  **Actualización de Estado**: Si el saldo `debe` llega a `0` o menos, la función también actualiza el `estado` de la factura a `PAGADA`.
  4.  **Integridad Garantizada**: Este enfoque asegura que el estado financiero siempre sea consistente. Es imposible que se registre un abono sin que se actualice el saldo de la factura correspondiente.

### 6. Funcionalidades de Administrador

La aplicación cuenta con una sección específica para administradores que proporciona herramientas para la gestión del sistema.

#### Creación de Trabajadores

- **Componente**: `AdminFunctionsSection` (`/widgets/admin/admin_functions_section.dart`).
- **Funcionalidad**: Proporciona una interfaz de usuario sencilla para que un administrador pueda crear nuevas cuentas de trabajador. El formulario captura el nombre, email y una contraseña temporal.
- **Interacción**: Al enviar el formulario, se realiza una llamada al endpoint `POST /api/workers` del backend para crear el nuevo usuario en Supabase, siguiendo el flujo descrito en la sección "Flujo de Creación de Trabajadores".

### 7. Configuración del Backend y Seguridad

#### Dualidad de Identificadores: `folio` vs. `clave_key`

Una decisión de diseño fundamental en la base de datos es el uso de dos identificadores para la tabla `formatos`:

- **`folio` (int8, PK)**: Es un número secuencial, autoincremental y la **verdadera clave primaria** de la tabla. Se utiliza internamente para todas las relaciones de clave foránea (`Foreign Key`) con otras tablas como `repuestos`, `servicios` y `facturas`. Esto optimiza el rendimiento de las consultas y garantiza la integridad referencial de manera eficiente.

- **`clave_key` (text, Unique)**: Es un identificador legible por humanos (ej. `F-001`, `F-002`) que se genera en el backend. Su propósito principal es para **visualización en la interfaz de usuario y como identificador de negocio**. Aunque es único, no se utiliza para las uniones (`JOINs`) a nivel de base de datos.

Esta separación es una práctica recomendada que combina un identificador de negocio amigable para el usuario con una clave primaria numérica y eficiente para el sistema.

#### Clave de Servicio de Supabase (`SUPABASE_SERVICE_KEY`)

El archivo `database.js` revela un detalle de seguridad y arquitectura crucial: el backend se inicializa utilizando la `SUPABASE_SERVICE_KEY`.

- **Privilegios de Administrador**: A diferencia de la `anon key` (usada en el frontend), la `service key` otorga acceso completo y sin restricciones a la base de datos. Esto permite al backend realizar operaciones privilegiadas, como la creación de usuarios o la modificación de datos sensibles, saltándose las políticas de seguridad a nivel de fila (RLS) si es necesario. Es fundamental que esta clave se mantenga segura y nunca se exponga en el lado del cliente.

#### Utilidades de Formato de Texto

El archivo `/utils/formatters.dart` contiene clases que mejoran la experiencia de usuario en los campos de texto:

- **`ThousandsSeparatorInputFormatter`**: Se aplica a los campos de costo. A medida que el usuario escribe un número (ej. `1500000`), el `formatter` lo transforma automáticamente en un formato de moneda legible (ej. `1.500.000`), facilitando la lectura de cifras grandes.
- **`UpperCaseTextFormatter`**: Se utiliza en campos como el de la placa del vehículo para convertir automáticamente todo el texto a mayúsculas, garantizando la consistencia de los datos.
