'use strict';

// Repeatable workshop-schema paridad tool.
//
// It reads the live catalog of a PostgreSQL/Supabase database and produces one
// canonical row per object (kind, key, definition). Two snapshots can be
// compared to classify differences as ok, missing, different, extra or
// dangerous. The tool never stores credentials: an operator runs the SQL by
// means of the workshop management token or a read-only connection and saves
// the JSON result.
//
// A freshly provisioned workshop must contain the same objects as the template
// applied to an empty database. Differences are reported, not repaired.

const KIND_ORDER = [
  'schema',
  'extension',
  'table',
  'column',
  'constraint',
  'index',
  'sequence',
  'function',
  'trigger',
  'policy',
  'rls',
  'grant',
  'type',
  'publication',
  'publication_table',
];

const DANGEROUS_GRANTEES = new Set(['anon', 'PUBLIC', 'public']);

function inventorySql() {
  return `
with catalog as (
  select 'schema'::text as kind, n.nspname::text as key, ''::text as def
    from pg_namespace n
    where n.nspname in ('public', 'private')

  union all
  select 'extension', e.extname, e.extnamespace::regnamespace::text
    from pg_extension e
    where e.extname <> 'plpgsql'
      and not exists (
        select 1 from pg_depend d
        where d.objid = e.oid and d.deptype = 'e' and d.refclassid = 'pg_extension'::regclass
          and d.refobjid <> e.oid
      )

  union all
  select 'table', n.nspname || '.' || c.relname,
         c.relkind::text || '|rls=' || c.relrowsecurity::text || '|force=' || c.relforcerowsecurity::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')

  union all
  select 'column', c.table_schema || '.' || c.table_name || '.' || c.column_name,
         c.data_type || '|nullable=' || c.is_nullable || '|default=' || coalesce(c.column_default, '')
         || case when c.character_maximum_length is not null
                 then '|maxlen=' || c.character_maximum_length::text else '' end
         || case when c.numeric_precision is not null
                 then '|precision=' || c.numeric_precision::text || ',scale=' || coalesce(c.numeric_scale::text, '') else '' end
         || case when c.datetime_precision is not null
                 then '|tmpprecision=' || c.datetime_precision::text else '' end
         || case when c.is_identity = 'YES'
                 then '|identity=' || c.identity_generation || ',' || c.identity_start || ',' || c.identity_increment else '' end
    from information_schema.columns c
    where c.table_schema in ('public', 'private')

  union all
  select 'constraint', n.nspname || '.' || c.relname || '.' || con.conname,
         con.contype::text || '|' || pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private')

  union all
  select 'index', i.schemaname || '.' || i.indexname, i.indexdef
    from pg_indexes i
    where i.schemaname in ('public', 'private')

  union all
  select 'sequence', s.sequence_schema || '.' || s.sequence_name,
         s.data_type || '|start=' || s.start_value || '|increment=' || s.increment
         || '|min=' || s.minimum_value || '|max=' || s.maximum_value || '|cycle=' || s.cycle_option
    from information_schema.sequences s
    where s.sequence_schema in ('public', 'private')

  union all
  select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         case p.prokind when 'p' then 'procedure' else 'function' end
         || '|returns=' || pg_get_function_result(p.oid)
         || '|language=' || l.lanname::text
         || '|secdef=' || p.prosecdef::text
         || '|volatility=' || p.provolatile::text
         || '|strict=' || p.proisstrict::text
         || '|parallel=' || p.proparallel::text
         || '|cfg=' || coalesce(array_to_string(p.proconfig, ','), '')
         || '|body=' || md5(p.prosrc)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')

  union all
  select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and not t.tgisinternal

  union all
  select 'policy', p.schemaname || '.' || p.tablename || '.' || p.policyname,
         p.permissive || '|' || p.cmd || '|roles='
         || (select string_agg(r, ',' order by r) from unnest(p.roles) r)
         || '|using=' || coalesce(p.qual, '') || '|check=' || coalesce(p.with_check, '')
    from pg_policies p
    where p.schemaname in ('public', 'private')

  union all
  select 'rls', n.nspname || '.' || c.relname,
         'enabled=' || c.relrowsecurity::text || '|forced=' || c.relforcerowsecurity::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')

  union all
  select 'grant', g.grantee || '|' || g.table_schema || '.' || g.table_name || '|' || g.privilege_type, 'table'
    from information_schema.role_table_grants g
    where g.table_schema in ('public', 'private')

  union all
  select 'grant', g.grantee || '|' || g.table_schema || '.' || g.table_name || '.' || g.column_name || '|' || g.privilege_type, 'column'
    from information_schema.role_column_grants g
    where g.table_schema in ('public', 'private')

  union all
  select 'grant', g.grantee || '|' || g.specific_schema || '.' || g.routine_name || '|' || g.privilege_type, 'routine'
    from information_schema.role_routine_grants g
    where g.specific_schema in ('public', 'private')

  union all
  select 'grant', g.grantee || '|' || g.object_schema || '.' || g.object_name || '|' || g.privilege_type, 'usage'
    from information_schema.role_usage_grants g
    where g.object_schema in ('public', 'private')

  union all
  select 'type', n.nspname || '.' || t.typname,
         case t.typtype
           when 'e' then 'enum:' || (select string_agg(e.enumlabel, ',' order by e.enumsortorder)
                                      from pg_enum e where e.enumtypid = t.oid)
           when 'd' then 'domain:' || format_type(t.typbasetype, t.typtypmod)
           else t.typtype::text end
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname in ('public', 'private') and t.typtype in ('e', 'd')

  union all
  select 'publication', p.pubname, 'alltables=' || p.puballtables::text
    from pg_publication p

  union all
  select 'publication_table', pt.pubname || '|' || pt.schemaname || '.' || pt.tablename, ''
    from pg_publication_tables pt
    where pt.schemaname in ('public', 'private')
)
select jsonb_agg(jsonb_build_object('kind', kind, 'key', key, 'def', def) order by kind, key) as inventory
from catalog;`;
}

function normalize(snapshot) {
  if (snapshot instanceof Map) {
    const map = new Map();
    for (const [id, item] of snapshot) {
      if (!item || typeof item.kind !== 'string' || typeof item.key !== 'string') continue;
      map.set(id, {
        kind: item.kind,
        key: item.key,
        def: typeof item.def === 'string' ? item.def : '',
      });
    }
    return map;
  }
  const rows = Array.isArray(snapshot)
    ? snapshot
    : snapshot && Array.isArray(snapshot.inventory)
      ? snapshot.inventory
      : snapshot && Array.isArray(snapshot.rows)
        ? snapshot.rows
        : [];
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row.kind !== 'string' || typeof row.key !== 'string') continue;
    map.set(`${row.kind}\u0000${row.key}`, {
      kind: row.kind,
      key: row.key,
      def: typeof row.def === 'string' ? row.def : '',
    });
  }
  return map;
}

async function snapshot(client) {
  const result = await client.query(inventorySql());
  const row = (result.rows || [])[0] || {};
  return normalize(row.inventory ?? row);
}

function kindRank(kind) {
  const index = KIND_ORDER.indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
}

function sortItems(items) {
  return items.sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || String(a.key).localeCompare(String(b.key)),
  );
}

function grantParts(key) {
  const [grantee, object, privilege] = String(key).split('|');
  return { grantee, object, privilege };
}

function isDangerousGrant(key) {
  const { grantee } = grantParts(key);
  return DANGEROUS_GRANTEES.has(grantee);
}

function describeFunction(def) {
  const attr = typeof def === 'string' ? def : '';
  const secdef = /secdef=true/.test(attr);
  const cfg = (attr.match(/\|cfg=(.*?)(\|body=|$)/) || [])[1] || '';
  return { secdef, cfg };
}

function dangerousReason(kind, key, expected, actual) {
  if (kind === 'rls') {
    if (/enabled=true/.test(expected || '') && /enabled=false/.test(actual || '')) {
      return 'RLS quedó deshabilitado para una tabla que lo requiere.';
    }
    if (/forced=true/.test(expected || '') && /forced=false/.test(actual || '')) {
      return 'La tabla dejó de forzar RLS para el propietario.';
    }
    return null;
  }
  if (kind === 'policy') {
    return 'La política de acceso difiere de la plantilla; revisar roles y expresiones.';
  }
  if (kind === 'grant') {
    if (isDangerousGrant(key)) {
      return 'El permiso otorgado a un rol público (anon/PUBLIC) no está en la plantilla.';
    }
    return null;
  }
  if (kind === 'function') {
    const before = describeFunction(expected);
    const now = describeFunction(actual);
    if (!before.secdef && now.secdef) {
      return 'Una función pasó a SECURITY DEFINER sin estar en la plantilla.';
    }
    if (before.cfg && !now.cfg) {
      return 'Una función perdió su search_path fijo.';
    }
    if (before.cfg && now.cfg !== before.cfg) {
      return `Una función cambió su search_path (${before.cfg} -> ${now.cfg}).`;
    }
    return null;
  }
  return null;
}

function compare(expectedSnapshot, actualSnapshot) {
  const expected = normalize(expectedSnapshot);
  const actual = normalize(actualSnapshot);
  const result = { ok: [], missing: [], different: [], extra: [], dangerous: [] };
  const danger = (kind, key, reason) => {
    if (reason) result.dangerous.push({ kind, key, reason });
  };

  for (const [id, item] of expected) {
    const live = actual.get(id);
    if (!live) {
      result.missing.push({ kind: item.kind, key: item.key, expected: item.def });
      if (item.kind === 'rls' && /enabled=true/.test(item.def)) {
        danger(item.kind, item.key, 'Falta la habilitación de RLS de una tabla protegida.');
      } else if (item.kind === 'policy') {
        danger(item.kind, item.key, 'Falta una política de acceso de la plantilla.');
      }
      continue;
    }
    if (live.def !== item.def) {
      result.different.push({ kind: item.kind, key: item.key, expected: item.def, actual: live.def });
      danger(item.kind, item.key, dangerousReason(item.kind, item.key, item.def, live.def));
      continue;
    }
    result.ok.push({ kind: item.kind, key: item.key });
  }

  for (const [id, item] of actual) {
    if (expected.has(id)) continue;
    result.extra.push({ kind: item.kind, key: item.key, actual: item.def });
    if (item.kind === 'grant' && isDangerousGrant(item.key)) {
      danger(item.kind, item.key, 'Permiso extra otorgado a un rol público (anon/PUBLIC).');
    } else if (item.kind === 'policy') {
      danger(item.kind, item.key, 'Política adicional sobre una tabla; revisar si debilita el acceso.');
    } else if (item.kind === 'rls' && /enabled=false/.test(item.def)) {
      danger(item.kind, item.key, 'Tabla adicional sin RLS.');
    } else if (item.kind === 'function' && describeFunction(item.def).secdef) {
      danger(item.kind, item.key, 'Función SECURITY DEFINER adicional a la plantilla.');
    }
  }

  for (const bucket of ['ok', 'missing', 'different', 'extra', 'dangerous']) sortItems(result[bucket]);
  return result;
}

function summarize(result) {
  const clean = result.missing.length === 0 && result.different.length === 0 && result.dangerous.length === 0;
  return {
    clean,
    counts: {
      ok: result.ok.length,
      missing: result.missing.length,
      different: result.different.length,
      extra: result.extra.length,
      dangerous: result.dangerous.length,
    },
  };
}

function formatReport(result) {
  const lines = [];
  const summary = summarize(result);
  lines.push(
    `Paridad: ${summary.clean ? 'OK' : 'REVISAR'} — ok=${summary.counts.ok} faltantes=${summary.counts.missing} ` +
      `diferentes=${summary.counts.different} adicionales=${summary.counts.extra} peligrosas=${summary.counts.dangerous}`,
  );
  const section = (title, items, format) => {
    if (!items.length) return;
    lines.push(`\n${title} (${items.length}):`);
    for (const item of items) lines.push(`  - [${item.kind}] ${item.key}${format ? ` -> ${format(item)}` : ''}`);
  };
  section('Peligrosas', result.dangerous, item => item.reason);
  section('Faltantes', result.missing);
  section('Diferentes', result.different, item => `esperado ${item.expected} | real ${item.actual}`);
  section('Adicionales', result.extra, item => item.actual);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { mode: 'help', files: [] };
  for (const value of argv) {
    if (value === '--sql' || value === '--sql-json') args.mode = 'sql';
    else if (value === 'compare') args.mode = 'compare';
    else if (value === '--help' || value === '-h') args.mode = 'help';
    else args.files.push(value);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
}

/* istanbul ignore next */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'sql') {
    process.stdout.write(inventorySql());
    process.stdout.write('\n');
    return;
  }
  if (args.mode === 'compare') {
    const [expectedFile, actualFile] = args.files;
    if (!expectedFile || !actualFile) throw new Error('Uso: compare <esperado.json> <real.json>');
    const result = compare(readJson(expectedFile), readJson(actualFile));
    process.stdout.write(`${formatReport(result)}\n`);
    process.exitCode = summarize(result).clean ? 0 : 1;
    return;
  }
  process.stdout.write(
    [
      'Uso:',
      '  node platform/schema-inventory.js --sql          Imprime la consulta de inventario.',
      '  node platform/schema-inventory.js compare A B   Compara dos inventarios JSON.',
      '',
      'Para auditar un taller: ejecutar --sql con su token de gestión, guardar el JSON',
      'como real.json y compararlo con el inventario de la plantilla (esperado.json).',
    ].join('\n') + '\n',
  );
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = {
  KIND_ORDER,
  compare,
  formatReport,
  inventorySql,
  snapshot,
  summarize,
};
