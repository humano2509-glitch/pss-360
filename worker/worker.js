const COLS = ['visitas', 'pss_cambios', 'pss_base', 'casos', 'notas', 'solicitudes'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-PSS-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
let cache = null, cacheAt = 0;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const b64enc = s => { let bin = ''; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

const gh = (env, file, init = {}) =>
  fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/${file}.json`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pss-360',
      ...init.headers,
    },
  });

async function leer(env, file) {
  const r = await gh(env, file);
  if (r.status === 404) return { data: file === 'config' ? {} : [], sha: undefined };
  if (!r.ok) throw new Error('GitHub respondió ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(b64dec(j.content)), sha: j.sha };
}

// Lee, cambia y guarda. Si otra persona guardó a la vez (409), vuelve a intentar.
async function cambiar(env, file, mutar, msg) {
  for (let i = 0; i < 4; i++) {
    const { data, sha } = await leer(env, file);
    const r = await gh(env, file, {
      method: 'PUT',
      body: JSON.stringify({ message: msg, content: b64enc(JSON.stringify(mutar(data), null, 1)), sha }),
    });
    if (r.ok) { cache = null; return; }
    if (r.status !== 409) throw new Error('GitHub respondió ' + r.status);
  }
  throw new Error('Conflicto al guardar, intente de nuevo');
}

async function listar(env) {
  if (cache && Date.now() - cacheAt < 15000) return cache;   // evita pasarse del límite de GitHub
  const out = {};
  for (const c of COLS) out[c] = (await leer(env, c)).data;
  Object.assign(out, (await leer(env, 'config')).data);       // ejecutivos, metas, supervisores
  cache = out; cacheAt = Date.now();
  return out;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.headers.get('X-PSS-Key') !== env.PSS_KEY) return json({ error: 'No autorizado' }, 401);
    try {
      if (req.method === 'GET') return json(await listar(env));

      const { action, id, data } = await req.json();
      if (action === 'import_pss') {
        await cambiar(env, 'pss_base', () => data, 'Importar catálogo PSS');
      } else if (action.startsWith('save_')) {
        const col = action.slice(5);
        if (col === 'config') {
          await cambiar(env, 'config', c => ({ ...c, [id]: data }), `Config: ${id}`);
        } else if (COLS.includes(col)) {
          await cambiar(env, col, arr => {
            const x = { ...data, id };
            const i = arr.findIndex(y => y.id === id);
            if (i >= 0) arr[i] = x; else arr.push(x);
            return arr;
          }, `${col}: ${id}`);
        } else return json({ error: 'Colección no válida' }, 400);
      } else if (action.startsWith('delete_')) {
        const col = action.slice(7);
        if (!COLS.includes(col)) return json({ error: 'Colección no válida' }, 400);
        await cambiar(env, col, arr => arr.filter(y => y.id !== id), `Borrar ${col}: ${id}`);
      } else return json({ error: 'Acción desconocida' }, 400);

      return json({ ok: true });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
