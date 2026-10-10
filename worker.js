// たんご用 AI連携 Worker
// Cloudflareのダッシュボードで新しいWorkerを作り、このコードを貼り付けて使います。
// 必要な設定:
//  - Bindings: Workers AI を追加(変数名は AI)  ※Claudeを使う場合は不要
//  - Secrets(任意): APP_TOKEN(合言葉)、ANTHROPIC_API_KEY(Claudeを使う場合)
//  - Variables(任意): ALLOW_ORIGIN(アプリのURL。例 https://tangoes.xxxx.workers.dev)、AI_MODEL、CLAUDE_MODEL

const MAX_ITEMS = 12;

function buildPrompt(items) {
  return `次の英単語それぞれについて、日本の大学受験(共通テスト・難関大の入試)向けの「重要フレーズ」(短い語句)を作り、その和訳を付けてください。

条件:
- 文ではなく、2〜6語ほどの短いフレーズにする。ピリオドは付けない。例: abandon → abandon a plan / 計画を断念する
- 前置詞との組み合わせ、コロケーション、入試で問われる語法を優先する。使い方が一目でわかる形にする。
- "b" (意味)に複数の意味や用法があるときは、意味ごとに1つずつフレーズを作る(最大3つ)。意味が1つなら、フレーズも1つでよい。
- 単語は、原形か自然な活用形で使う。
- 和訳は、フレーズに対応する短く自然な日本語にする。
- "e" に既存の例文やフレーズが入っている単語は、それを一字一句そのまま使い、"j"(和訳)だけ作る。既存が複数行のときは、同じ数だけ和訳を作る。
- "e" と "j" は配列にし、同じ順・同じ個数にする。
- 出力はJSONのみ。説明文やコードブロックは付けない。形式: {"results":[{"f":"単語","e":["フレーズ1","フレーズ2"],"j":["和訳1","和訳2"]}]}

対象の単語:
${JSON.stringify(items)}`;
}
function joinLines(v) {
  const a = Array.isArray(v) ? v : String(v || '').split(/\r?\n/);
  return a.map((x) => String(x || '').trim()).filter(Boolean).join('\n');
}

function extractList(text) {
  const s = String(text || '');
  const a = s.indexOf('['), o = s.indexOf('{');
  let body;
  if (a >= 0 && (o < 0 || a < o)) body = s.slice(a, s.lastIndexOf(']') + 1);
  else if (o >= 0) body = s.slice(o, s.lastIndexOf('}') + 1);
  else throw new Error('AIの応答を読み取れませんでした');
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { throw new Error('AIの応答がJSONではありませんでした'); }
  const list = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(list)) throw new Error('AIの応答の形式が違いました');
  return list;
}

async function callClaude(env, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      temperature: 0.4,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Claude APIのエラー ' + r.status));
  return (j.content || []).map((c) => c.text || '').join('');
}

async function callWorkersAI(env, prompt) {
  const model = env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const r = await env.AI.run(model, {
    messages: [
      { role: 'system', content: 'あなたは日本の大学受験向けの英語教材を作る、経験豊富な教師です。指示された形式のJSONだけを出力します。' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 2500,
    temperature: 0.4,
  });
  const t = r && r.response;
  return typeof t === 'string' ? t : JSON.stringify(t || '');
}

// ---- 通知(Web Push)。空の通知だけを送るので、暗号化は不要。VAPIDの鍵は、初回にWorkerが作ってKVに保存する ----
const b64u = (buf) => { let s = ''; new Uint8Array(buf).forEach((c) => (s += String.fromCharCode(c))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
async function getVapid(env) {
  const saved = await env.KV.get('vapid');
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const v = { jwk: priv, pub: b64u(raw) };
  await env.KV.put('vapid', JSON.stringify(v));
  return v;
}
async function vapidHeader(env, endpoint) {
  const v = await getVapid(env);
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const body = enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:noreply@example.com' });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + v.pub;
}
async function sendPush(env, sub) {
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: await vapidHeader(env, sub.endpoint), TTL: '43200', Urgency: 'normal' } });
  return r.status;
}
function localDay(tz) { const d = new Date(Date.now() - (tz || 0) * 60000); return { day: d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate(), hour: d.getUTCHours(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
function dayGap(a, b) {
  const p = (s) => { const q = String(s || '').split('-'); return q.length === 3 ? Date.UTC(+q[0], +q[1] - 1, +q[2]) : NaN; };
  const x = p(a), y = p(b);
  return isNaN(x) || isNaN(y) ? 0 : Math.max(0, Math.round((y - x) / 86400000));
}
async function pushTick(env) {
  if (!env.KV) return;
  const raw = await env.KV.get('push');
  if (!raw) return;
  const cfg = JSON.parse(raw);
  if (!cfg.sub || cfg.off) return;
  const now = localDay(cfg.tz);
  if (cfg.lastDone === now.day) return;
  const gap = dayGap(cfg.lastDone || cfg.since, now.day);
  let kind = '';
  // 決めた時刻の通知。何日も反応がないときは、3日あとからは4日おきに減らす
  const target = (cfg.hour || 0) * 60 + (cfg.min || 0);
  if (now.mins >= target && now.mins < target + 60 && cfg.lastSent !== now.day && (gap <= 3 || gap % 4 === 0)) kind = 'main';
  // 夜10時の最後の通知は、連続記録が危ないときだけ
  else if (now.mins >= 22 * 60 && now.mins < 23 * 60 && target < 22 * 60 && (cfg.streak || 0) >= 1 && gap <= 1 && cfg.lastSent2 !== now.day) kind = 'risk';
  if (!kind) return;
  const st = await sendPush(env, cfg.sub);
  if (st === 404 || st === 410) { await env.KV.delete('push'); return; }
  if (kind === 'main') cfg.lastSent = now.day; else cfg.lastSent2 = now.day;
  await env.KV.put('push', JSON.stringify(cfg));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allow = env.ALLOW_ORIGIN ? env.ALLOW_ORIGIN : '*';
    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Headers': 'content-type,x-app-token',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (env.ALLOW_ORIGIN && origin && origin !== env.ALLOW_ORIGIN) return json({ error: 'このアドレスからは使えません' }, 403);
    const reqUrl = new URL(request.url);
    if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN && reqUrl.searchParams.get('t') !== env.APP_TOKEN) return json({ error: '合言葉が違います' }, 401);

    const provider = env.ANTHROPIC_API_KEY ? 'claude' : env.AI ? 'workers-ai' : 'none';
    const path = reqUrl.pathname;

    if (path.endsWith('/ping')) return json({ ok: true, provider, version: 10, ai: !!env.AI, claude: !!env.ANTHROPIC_API_KEY, token: !!env.APP_TOKEN, kv: !!env.KV, push: !!env.KV });

    // 通知の設定(KVが必要)
    if (path.includes('/push/')) {
      if (!env.KV) return json({ error: 'KVが設定されていません' }, 501);
      if (path.endsWith('/push/key')) return json({ ok: true, key: (await getVapid(env)).pub });
      if (request.method !== 'POST') return json({ error: 'この操作はできません' }, 405);
      let b = {};
      try { b = await request.json(); } catch (e) {}
      const cur = JSON.parse((await env.KV.get('push')) || '{}');
      if (path.endsWith('/push/sub')) {
        if (!b.sub || !b.sub.endpoint) return json({ error: '通知の登録情報がありません' }, 400);
        const cfg = { sub: b.sub, hour: Math.max(0, Math.min(23, b.hour == null ? 19 : +b.hour || 0)), min: Math.max(0, Math.min(59, +b.min || 0)), tz: +b.tz || 0, lastDone: b.day || cur.lastDone || '', since: cur.since || localDay(+b.tz || 0).day, lastSent: cur.lastSent || '', lastSent2: cur.lastSent2 || '', streak: cur.streak || 0 };
        await env.KV.put('push', JSON.stringify(cfg));
        return json({ ok: true });
      }
      if (path.endsWith('/push/unsub')) { await env.KV.delete('push'); return json({ ok: true }); }
      if (path.endsWith('/push/state')) {
        if (cur.sub) { if (b.day) cur.lastDone = b.day; if (b.streak !== undefined) cur.streak = Math.max(0, +b.streak || 0); if (b.hour !== undefined) cur.hour = Math.max(0, Math.min(23, +b.hour || 0)); if (b.min !== undefined) cur.min = Math.max(0, Math.min(59, +b.min || 0)); await env.KV.put('push', JSON.stringify(cur)); }
        return json({ ok: true, registered: !!cur.sub });
      }
      if (path.endsWith('/push/test')) {
        if (!cur.sub) return json({ error: '通知が登録されていません' }, 400);
        const st = await sendPush(env, cur.sub);
        return json({ ok: st >= 200 && st < 300, status: st });
      }
      return json({ error: '見つかりません' }, 404);
    }

    // クラウドバックアップ(KVに1件だけ保存。6時間以上たっていたら、前の保存を「ひとつ前」に残す)
    if (path.endsWith('/sync')) {
      if (!env.KV) return json({ error: 'KVが設定されていません(Workerの設定でKVを追加してください)' }, 501);
      if (request.method === 'GET' && reqUrl.searchParams.get('test')) {
        const v = String(Date.now());
        await env.KV.put('test', v);
        const back = await env.KV.get('test');
        return json({ ok: back === v, kv: true });
      }
      if (request.method === 'GET') {
        const key = reqUrl.searchParams.get('gen') === 'prev' ? 'bk-prev' : 'bk';
        const v = await env.KV.get(key);
        if (!v) return json({ error: '保存されたバックアップがありません' }, 404);
        const o = JSON.parse(v);
        return json({ ok: true, t: o.t, text: o.text });
      }
      if (request.method === 'POST') {
        const text = await request.text();
        if (!text.startsWith('TANGO BACKUP 1 ') || text.length > 20000000) return json({ error: 'バックアップの形式が違います' }, 400);
        const cur = await env.KV.get('bk');
        if (cur) {
          try { const c = JSON.parse(cur); if (Date.now() - c.t > 6 * 3600 * 1000) await env.KV.put('bk-prev', cur); } catch (e) {}
        }
        const t = Date.now();
        await env.KV.put('bk', JSON.stringify({ t, text }));
        return json({ ok: true, t });
      }
      return json({ error: 'この操作はできません' }, 405);
    }
    let audioLang = 'en';
    const EXPOSE = 'x-source,x-tried,x-lang';
    const audioHeaders = (src, tried) => ({ ...cors, 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=2592000', 'x-source': src, 'x-tried': tried || '-', 'x-lang': audioLang, 'Access-Control-Expose-Headers': EXPOSE });
    const melo = async (text, lang) => {
      if (!env.AI) return null;
      const r = await env.AI.run('@cf/myshell-ai/melotts', { prompt: text, lang: lang || 'en' });
      if (r && typeof r.audio === 'string') {
        const bin = atob(r.audio);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }
      if (r instanceof ArrayBuffer || ArrayBuffer.isView(r)) return r;
      return null;
    };

    if (path.endsWith('/audio') && request.method === 'GET') {
      const text = (reqUrl.searchParams.get('text') || '').trim().slice(0, 300);
      if (!text) return json({ error: 'text がありません' }, 400);
      if ((reqUrl.searchParams.get('lang') || '') === 'ja') {
        audioLang = 'ja';
        const tried = [];
        const urls = [
          ['youdao-ja', 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) + '&le=jap'],
          ['google-ja', 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ja&q=' + encodeURIComponent(text)],
        ];
        for (const [name, u] of urls) {
          try {
            const r = await fetch(u, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 86400, cacheEverything: true } });
            const ct = r.headers.get('content-type') || '';
            if (r.ok && /audio|mpeg|octet/.test(ct)) {
              const buf = await r.arrayBuffer();
              if (buf.byteLength > 500) { tried.push(name + ':OK'); return new Response(buf, { headers: audioHeaders(name, tried.join(',')) }); }
              tried.push(name + ':small');
            } else tried.push(name + ':' + r.status);
          } catch (e) { tried.push(name + ':' + ((e && e.name) || 'error')); }
        }
        for (const lg of ['ja', 'jp']) {
          try {
            const bytes = await melo(text, lg);
            if (bytes) { tried.push('melotts-' + lg + ':OK'); return new Response(bytes, { headers: audioHeaders('melotts-' + lg, tried.join(',')) }); }
            tried.push('melotts-' + lg + ':none');
          } catch (e) { tried.push('melotts-' + lg + ':' + String((e && e.message) || e).slice(0, 50)); }
        }
        return new Response(JSON.stringify({ error: '日本語の音声を取得できませんでした', tried: tried.join(',') }), { status: 502, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'x-tried': tried.join(','), 'Access-Control-Expose-Headers': EXPOSE } });
      }
      const cands = [];
      if (/^[A-Za-z]+$/.test(text)) {
        const k = text.toLowerCase();
        cands.push(['dictionaryapi-us', 'https://api.dictionaryapi.dev/media/pronunciations/en/' + k + '-us.mp3']);
        cands.push(['dictionaryapi-uk', 'https://api.dictionaryapi.dev/media/pronunciations/en/' + k + '-uk.mp3']);
      }
      cands.push(['youdao', 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) + '&type=2']);
      const tried = [];
      const fetchOne = async ([name, u], ms) => {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(ms), cf: { cacheTtl: 86400, cacheEverything: true } });
          const ct = r.headers.get('content-type') || '';
          if (r.ok && /audio|mpeg|octet/.test(ct)) {
            const buf = await r.arrayBuffer();
            if (buf.byteLength > 500) { tried.push(name + ':OK'); return { name, buf }; }
            tried.push(name + ':small');
          } else tried.push(name + ':' + r.status);
        } catch (e) { tried.push(name + ':' + ((e && e.name) || 'error')); }
        return null;
      };
      // Youdaoを先に試し、だめなときだけ辞書APIを試す(辞書APIは応答しないことが多いため)
      let hit = await fetchOne(cands.find((c) => c[0] === 'youdao'), 3000);
      if (!hit) {
        const got = await Promise.all(cands.filter((c) => c[0] !== 'youdao').map((c) => fetchOne(c, 1500)));
        hit = got.find(Boolean) || null;
      }
      if (hit) return new Response(hit.buf, { headers: audioHeaders(hit.name, tried.join(',')) });
      try {
        const bytes = await melo(text);
        if (bytes) { tried.push('melotts:OK'); return new Response(bytes, { headers: audioHeaders('melotts', tried.join(',')) }); }
        tried.push('melotts:none');
      } catch (e) { tried.push('melotts:' + String((e && e.message) || e).slice(0, 60)); }
      return new Response(JSON.stringify({ error: '音声を取得できませんでした', tried: tried.join(',') }), { status: 502, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'x-tried': tried.join(','), 'Access-Control-Expose-Headers': EXPOSE } });
    }

    if (path.endsWith('/tts') && request.method === 'GET') {
      const text = (reqUrl.searchParams.get('text') || '').slice(0, 300);
      if (!text) return json({ error: 'text がありません' }, 400);
      if (!env.AI) return json({ error: 'Workers AI が設定されていません' }, 500);
      try {
        const bytes = await melo(text);
        if (bytes) return new Response(bytes, { headers: audioHeaders('melotts') });
        return json({ error: '音声の形式が想定と違いました' }, 502);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 502);
      }
    }

    if (provider === 'none') return json({ error: 'AIの設定がありません(Workers AIのバインディング、またはANTHROPIC_API_KEYを設定してください)' }, 500);

    if (path.endsWith('/fill') && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: '送られたデータが読み取れません' }, 400); }
      const items = (Array.isArray(body.items) ? body.items : [])
        .slice(0, MAX_ITEMS)
        .map((x) => ({ f: String(x.f || '').slice(0, 60), b: String(x.b || '').slice(0, 120), e: String(x.e || '').slice(0, 300) }))
        .filter((x) => x.f && x.b);
      if (!items.length) return json({ error: '単語がありません' }, 400);
      const others = (Array.isArray(body.others) ? body.others : []).slice(0, 80).map((x) => String(x).slice(0, 40));
      try {
        const prompt = buildPrompt(items);
        const text = provider === 'claude' ? await callClaude(env, prompt) : await callWorkersAI(env, prompt);
        const list = extractList(text);
        const byF = {};
        items.forEach((x) => { byF[x.f.toLowerCase()] = x; });
        const results = [];
        list.forEach((r) => {
          const src = byF[String((r && r.f) || '').trim().toLowerCase()];
          if (!src) return;
          const e = src.e ? src.e : joinLines(r.e);
          const j = joinLines(r.j);
          if (e || j) results.push({ f: src.f, e, j });
        });
        return json({ results, provider });
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 502);
      }
    }
    return json({ error: '見つかりません' }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pushTick(env));
  },
};
