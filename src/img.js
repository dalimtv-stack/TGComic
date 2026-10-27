// Vercel: /api/img?url=https://...  Descarga una imagen externa y la devuelve con CORS
// (para portadas desde URL de servidores que bloquean CORS, como Comic Vine).
const MAX = 15 * 1024 * 1024;

export async function GET(request) {
  const target = new URL(request.url).searchParams.get('url') || '';
  let u;
  try { u = new URL(target); } catch { return new Response('URL no válida', { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) return new Response('URL no válida', { status: 400 });
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host.endsWith('.internal')) {
    return new Response('Dirección no permitida', { status: 400 });
  }
  let res;
  try {
    res = await fetch(u.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
    });
  } catch (e) {
    return new Response('No se pudo descargar: ' + (e?.message || e), { status: 502 });
  }
  if (!res.ok) return new Response('HTTP ' + res.status, { status: 502 });
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) return new Response('La URL no es una imagen', { status: 415 });
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX) return new Response('Imagen demasiado grande', { status: 413 });
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
