// たんご用 AI連携 Worker
// Cloudflareのダッシュボードで新しいWorkerを作り、このコードを貼り付けて使います。
// 必要な設定:
//  - Bindings: Workers AI を追加(変数名は AI)  ※Claudeを使う場合は不要
//  - Secrets(任意): APP_TOKEN(合言葉)、ANTHROPIC_API_KEY(Claudeを使う場合)
//  - Variables(任意): ALLOW_ORIGIN(アプリのURL。例 https://tangoes.xxxx.workers.dev)、AI_MODEL、CLAUDE_MODEL

const MAX_ITEMS = 12;

function buildPrompt(items, others) {
  return `次の英単語それぞれについて、日本の大学受験(共通テスト・難関大の入試)向けの英語の例文を1つ作り、その和訳を付けてください。

条件:
- 例文は、入試で見かける程度の自然で標準的な英文を1文(長すぎない)にする。
- 単語のよくある使い方(前置詞との組み合わせ、コロケーション、語法)が伝わる文にする。
- 「他の登録単語」を、不自然にならない範囲で例文に含めてよい(無理に含めない)。
- 単語は、例文の中で原形か、自然な活用形で使う。
- 和訳は自然な日本語にする。
- "e" に既存の例文が入っている単語は、その例文を一字一句そのまま使い、"j"(和訳)だけ作る。
- 出力はJSONのみ。説明文やコードブロックは付けない。形式: {"results":[{"f":"単語","e":"例文","j":"和訳"}]}

対象の単語:
${JSON.stringify(items)}

他の登録単語:
${others.join(', ')}`;
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

    if (path.endsWith('/ping')) return json({ ok: true, provider });
    if (path.endsWith('/tts') && request.method === 'GET') {
      const text = (reqUrl.searchParams.get('text') || '').slice(0, 300);
      if (!text) return json({ error: 'text がありません' }, 400);
      if (!env.AI) return json({ error: 'Workers AI が設定されていません' }, 500);
      try {
        const r = await env.AI.run('@cf/myshell-ai/melotts', { prompt: text, lang: 'en' });
        const headers = { ...cors, 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=31536000, immutable' };
        if (r && typeof r.audio === 'string') {
          const bin = atob(r.audio);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new Response(bytes, { headers });
        }
        if (r instanceof ReadableStream || r instanceof ArrayBuffer || ArrayBuffer.isView(r)) return new Response(r, { headers });
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
        const prompt = buildPrompt(items, others);
        const text = provider === 'claude' ? await callClaude(env, prompt) : await callWorkersAI(env, prompt);
        const list = extractList(text);
        const byF = {};
        items.forEach((x) => { byF[x.f.toLowerCase()] = x; });
        const results = [];
        list.forEach((r) => {
          const src = byF[String((r && r.f) || '').trim().toLowerCase()];
          if (!src) return;
          const e = src.e ? src.e : String(r.e || '').trim();
          const j = String(r.j || '').trim();
          if (e || j) results.push({ f: src.f, e, j });
        });
        return json({ results, provider });
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 502);
      }
    }
    return json({ error: '見つかりません' }, 404);
  },
};
