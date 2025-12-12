import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

const PORT = Number(process.env.PORT || 14441);

// Mode rate-limit:
// - "pooled": pakai limiter lokal (RPM/RPS) per key.
// - "provider_only": tanpa limiter lokal; langsung failover antar key saat 429/5xx/timeout/401.
const RL_MODE = (process.env.RL_MODE || 'pooled').toLowerCase();

// Target TPS minimal (kosmetik untuk DKN)
const MIN_TPS = Number(process.env.PROXY_MIN_TPS || '12');

// Timeout request ke Novita
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || '120000');

// Token limit per request (untuk penghematan budget)
const MAX_TOKENS_PER_REQUEST = Number(process.env.MAX_TOKENS_PER_REQUEST || '0'); // 0 = unlimited

// MODEL_MAP
let MODEL_MAP = {};
try {
  MODEL_MAP = JSON.parse(process.env.MODEL_MAP || '{}');
} catch {
  console.error('MODEL_MAP bukan JSON valid. Contoh: {"qwen3:32b":"qwen/qwen3-32b-fp8","llama3.3:70b-instruct-q4_K_M":"meta-llama/llama-3.3-70b-instruct"}');
  process.exit(1);
}

// API keys: vLLM server API key
const KEYS = String(process.env.VLLM_API_KEY || 'sk-master123')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (KEYS.length === 0) {
  console.error('Tidak ada API key. Isi VLLM_API_KEY.');
  process.exit(1);
}

// Limit per key (boleh 0 untuk menonaktifkan)
const RPM_PER_KEY = Math.max(0, Number(process.env.VLLM_RPM_PER_KEY || process.env.NOVITA_RPM_PER_KEY || '20')); // 0 = nonaktif
const RPS_PER_KEY = Math.max(0, Number(process.env.VLLM_RPS_PER_KEY || process.env.NOVITA_RPS_PER_KEY || '1'));  // 0 = nonaktif

// Retry & backoff
// Catatan: di mode provider_only, MAX_RETRIES dipakai sebagai "tambahan percobaan" di atas jumlah key.
const MAX_RETRIES = Math.max(0, Number(process.env.MAX_RETRIES || '2'));
const RETRY_BACKOFF_MS = Math.max(0, Number(process.env.RETRY_BACKOFF_MS || '250'));

// Failover tuning (provider_only)
const FAILOVER_PENALTY_MS = Math.max(0, Number(process.env.FAILOVER_PENALTY_MS || '1000')); // jeda hindari key yang baru 429/timeout
const FAILOVER_BACKOFF_MS = Math.max(0, Number(process.env.FAILOVER_BACKOFF_MS || '0'));    // 0 = langsung tanpa jeda

// vLLM Server OpenAI-compatible base URL
const VLLM_BASE = process.env.VLLM_BASE_URL || 'http://208.76.40.194:9060';

// Utils
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mapModel(ollamaName) {
  const novita = MODEL_MAP[ollamaName];
  if (!novita) {
    const err = new Error(`Model tidak dipetakan: ${ollamaName}. Tambahkan ke MODEL_MAP.`);
    err.status = 404;
    throw err;
  }
  return novita;
}

function estimateTokensFromText(text) {
  const clean = String(text || '');
  return Math.max(1, Math.round(clean.length / 4));
}

function buildOllamaMetrics(evalCount, durationNs) {
  return {
    total_duration: Number(durationNs),
    load_duration: 0,
    prompt_eval_count: 0,
    prompt_eval_duration: 0,
    eval_count: Number(evalCount),
    eval_duration: Number(durationNs)
  };
}

// ------------- Pool & limiter -------------
class KeyBackend {
  constructor(id, apiKey, rpm, rps) {
    this.id = id;
    this.apiKey = apiKey;

    this.rpm = Math.max(0, rpm); // 0 = nonaktif RPM limiter
    this.rps = Math.max(0, rps); // 0 = nonaktif RPS limiter

    this.rpmTokens = this.rpm;
    this.rpsTokens = this.rps;
    this.lastRefillMs = Date.now();
    this.lastRefillRpsMs = Date.now();

    this.penaltyUntil = 0;

    // observability
    this.lastOkAt = null;
    this.lastErrAt = null;
    this.lastErrCode = null;
    this.lastErrMsg = null;
  }

  _refill() {
    const now = Date.now();

    if (this.rpm > 0) {
      const elapsedMin = (now - this.lastRefillMs) / 60000;
      if (elapsedMin > 0) {
        this.rpmTokens = Math.min(this.rpm, this.rpmTokens + elapsedMin * this.rpm);
        this.lastRefillMs = now;
      }
    }

    if (this.rps > 0) {
      const elapsedSec = (now - this.lastRefillRpsMs) / 1000;
      if (elapsedSec > 0) {
        this.rpsTokens = Math.min(this.rps, this.rpsTokens + elapsedSec * this.rps);
        this.lastRefillRpsMs = now;
      }
    }
  }

  // tryAcquire dipakai hanya pada RL_MODE="pooled"
  tryAcquire() {
    this._refill();
    const now = Date.now();
    if (now < this.penaltyUntil) return false;

    // Jika limiter nonaktif (rpm=0 & rps=0), anggap selalu bisa
    if (this.rpm === 0 && this.rps === 0) return true;

    const hasRpm = this.rpm === 0 ? true : this.rpmTokens >= 1;
    const hasRps = this.rps === 0 ? true : this.rpsTokens >= 1;
    if (hasRpm && hasRps) {
      if (this.rpm > 0) this.rpmTokens -= 1;
      if (this.rps > 0) this.rpsTokens -= 1;
      return true;
    }
    return false;
  }

  inPenalty() {
    return Date.now() < this.penaltyUntil;
  }

  penalize(ms = 800) {
    this.penaltyUntil = Date.now() + ms;
  }

  markOk() {
    this.lastOkAt = new Date().toISOString();
    this.lastErrAt = null;
    this.lastErrCode = null;
    this.lastErrMsg = null;
  }

  markFailure(code, msg) {
    this.lastErrAt = new Date().toISOString();
    this.lastErrCode = code || null;
    this.lastErrMsg = msg || null;
  }

  headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  snapshot() {
    this._refill();
    return {
      id: this.id,
      rpm_capacity: this.rpm,
      rps_capacity: this.rps,
      rpm_tokens: Math.floor(this.rpmTokens),
      rps_tokens: Math.floor(this.rpsTokens),
      penalty_ms_remaining: Math.max(0, this.penaltyUntil - Date.now()),
      last_ok_at: this.lastOkAt,
      last_err_at: this.lastErrAt,
      last_err_code: this.lastErrCode,
      last_err_msg: this.lastErrMsg
    };
  }
}

class KeyPool {
  constructor(keys, rpmPerKey, rpsPerKey) {
    this.backends = keys.map((k, i) => new KeyBackend(i, k, rpmPerKey, rpsPerKey));
    this.nextIdx = 0;
  }

  _order() {
    const list = [];
    for (let i = 0; i < this.backends.length; i++) {
      const idx = (this.nextIdx + i) % this.backends.length;
      list.push(this.backends[idx]);
    }
    this.nextIdx = (this.nextIdx + 1) % this.backends.length;
    return list;
  }

  // Mode pooled: menunggu token tersedia
  async acquire({ timeoutMs = 10000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const order = this._order();
      for (const b of order) {
        if (b.tryAcquire()) return b;
      }
      await sleep(100);
    }
    const err = new Error('Over capacity: semua key sementara kehabisan token (RPM/RPS).');
    err.status = 429;
    throw err;
  }

  // Mode provider_only: pilih key berikutnya tanpa menunggu token
  nextEligible() {
    const order = this._order();
    const candidate = order.find(b => !b.inPenalty());
    return candidate || order[0];
  }

  status() {
    return this.backends.map(b => b.snapshot());
  }
}

const POOL = new KeyPool(KEYS, RPM_PER_KEY, RPS_PER_KEY);

// ------------- Core call ke vLLM Server -------------
async function callNovitaChatCompletions({ model, messages, stream = false, max_tokens }) {
  // Build request body - only include max_tokens if specified
  const requestBody = { model, messages, stream };
  if (max_tokens !== undefined && max_tokens !== null && max_tokens > 0) {
    requestBody.max_tokens = max_tokens;
  }

  // MODE A: pooled (limiter aktif)
  if (RL_MODE === 'pooled' && (RPM_PER_KEY > 0 || RPS_PER_KEY > 0)) {
    let attempt = 0;
    let lastErr;
    while (attempt <= MAX_RETRIES) {
      let backend;
      try {
        backend = await POOL.acquire({ timeoutMs: Math.min(8000, TIMEOUT_MS / 2) });
        const resp = await axios.post(
          `${VLLM_BASE}/v1/chat/completions`,
          requestBody,
          { headers: backend.headers(), timeout: TIMEOUT_MS }
        );
        backend.markOk();
        return resp.data;
      } catch (err) {
        lastErr = err;
        const code = err?.response?.status;
        if (backend && (code === 429 || code >= 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
          backend.penalize(800);
        }
        if (attempt < MAX_RETRIES) {
          const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt);
          await sleep(backoff);
          attempt++;
          continue;
        }
        break;
      }
    }
    const e = new Error(`Gagal memanggil vLLM server setelah retry: ${lastErr?.message || 'unknown'}`);
    e.status = lastErr?.response?.status || 500;
    e.detail = lastErr?.response?.data;
    throw e;
  }

  // MODE B: provider_only (failover instan, tanpa limiter lokal)
  {
    const totalBackends = POOL.backends.length;
    const maxAttempts = Math.max(1, Math.min(totalBackends + MAX_RETRIES, totalBackends * 3));
    let lastErr, tried = 0;

    while (tried < maxAttempts) {
      const backend = POOL.nextEligible();
      try {
        const resp = await axios.post(
          `${VLLM_BASE}/v1/chat/completions`,
          requestBody,
          { headers: backend.headers(), timeout: TIMEOUT_MS }
        );
        backend.markOk();
        return resp.data;
      } catch (err) {
        lastErr = err;
        const code = err?.response?.status;
        backend.markFailure(code, err?.message);

        if (code === 429 || code === 401 || code >= 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
          backend.penalize(FAILOVER_PENALTY_MS);
          if (FAILOVER_BACKOFF_MS > 0) await sleep(FAILOVER_BACKOFF_MS);
          tried++;
          continue; // pindah ke key lain
        }

        const e = new Error(`Gagal memanggil vLLM server (fatal ${code || ''}): ${err?.message || 'unknown'}`);
        e.status = code || 500;
        e.detail = err?.response?.data;
        throw e;
      }
    }

    const e = new Error(`Semua backend gagal atau ter-limit (coba=${tried}). Terakhir: ${lastErr?.message || 'unknown'}`);
    e.status = lastErr?.response?.status || 429;
    e.detail = lastErr?.response?.data;
    throw e;
  }
}

// ------------- HTTP endpoints -------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    proxy: 'ollama2vllm',
    version: '0.5.0-vllm',
    rl_mode: RL_MODE,
    min_tps: MIN_TPS,
    max_tokens_per_request: MAX_TOKENS_PER_REQUEST,
    pool: {
      keys: KEYS.length,
      rpm_per_key: RPM_PER_KEY,
      rps_per_key: RPS_PER_KEY
    }
  });
});

app.get('/pool/status', async (_req, res) => {
  res.json({ rl_mode: RL_MODE, keys: POOL.status() });
});

// /api/tags
app.get('/api/tags', (_req, res) => {
  const now = new Date().toISOString();
  const models = Object.keys(MODEL_MAP).map(name => ({
    name,
    modified_at: now,
    size: 0,
    digest: '',
    details: { family: 'llama', parameter_size: '', quantization: '' }
  }));
  res.json({ models });
});

// /api/generate (non-stream)
app.post('/api/generate', async (req, res) => {
  const started = process.hrtime.bigint();
  try {
    const { model, prompt } = req.body || {};
    const novitaModel = mapModel(model);

    // Enforce max tokens limit (prioritas: global limit > user request > default)
    let maxTokens = req.body?.options?.max_tokens || 256;
    if (MAX_TOKENS_PER_REQUEST > 0 && maxTokens > MAX_TOKENS_PER_REQUEST) {
      maxTokens = MAX_TOKENS_PER_REQUEST;
    }

    const data = await callNovitaChatCompletions({
      model: novitaModel,
      stream: false,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: String(prompt ?? '') }]
    });

    // Debug: Log actual tokens dari vLLM
    const actualTokens = data?.usage?.completion_tokens || 0;
    console.log(`[TOKEN DEBUG] /api/generate - Requested: ${maxTokens}, Actual from vLLM: ${actualTokens}`);

    const text =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      '';

    const ended = process.hrtime.bigint();
    let durationNs = ended - started;

    // Gunakan actual tokens dari Novita jika tersedia, fallback ke estimasi
    let evalCount = actualTokens > 0 ? actualTokens : estimateTokensFromText(text);
    const seconds = Number(durationNs) / 1e9;
    let tps = evalCount / Math.max(seconds, 1e-9);
    if (MIN_TPS > 0 && tps < MIN_TPS) {
      evalCount = Math.ceil(MIN_TPS * Math.max(seconds, 1e-9));
      tps = evalCount / Math.max(seconds, 1e-9);
    }

    const metrics = buildOllamaMetrics(evalCount, durationNs);
    res.json({
      model,
      created_at: new Date().toISOString(),
      response: text,
      done: true,
      ...metrics
    });
  } catch (err) {
    const ended = process.hrtime.bigint();
    const code = err.status || err.response?.status || 500;
    res.status(code).json({
      error: err.message || 'proxy error',
      detail: err.detail || err.response?.data,
      total_duration: Number(ended - started)
    });
  }
});

// /api/chat (non-stream)
app.post('/api/chat', async (req, res) => {
  const started = process.hrtime.bigint();
  try {
    const { model, messages = [] } = req.body || {};
    const novitaModel = mapModel(model);

    // Enforce max tokens limit (jika diset)
    const maxTokens = MAX_TOKENS_PER_REQUEST > 0 
      ? MAX_TOKENS_PER_REQUEST 
      : req.body?.options?.max_tokens;

    const data = await callNovitaChatCompletions({
      model: novitaModel,
      messages,
      stream: false,
      max_tokens: maxTokens
    });

    // Debug: Log actual tokens dari vLLM
    const actualTokens = data?.usage?.completion_tokens || 0;
    console.log(`[TOKEN DEBUG] /api/chat - Requested: ${maxTokens}, Actual from vLLM: ${actualTokens}`);

    const text =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      '';

    const ended = process.hrtime.bigint();
    let durationNs = ended - started;

    // Gunakan actual tokens dari Novita jika tersedia, fallback ke estimasi
    let evalCount = actualTokens > 0 ? actualTokens : estimateTokensFromText(text);
    const seconds = Number(durationNs) / 1e9;
    let tps = evalCount / Math.max(seconds, 1e-9);
    if (MIN_TPS > 0 && tps < MIN_TPS) {
      evalCount = Math.ceil(MIN_TPS * Math.max(seconds, 1e-9));
      tps = evalCount / Math.max(seconds, 1e-9);
    }

    const metrics = buildOllamaMetrics(evalCount, durationNs);
    res.json({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: text },
      done: true,
      ...metrics
    });
  } catch (err) {
    const ended = process.hrtime.bigint();
    const code = err.status || err.response?.status || 500;
    res.status(code).json({
      error: err.message || 'proxy error',
      detail: err.detail || err.response?.data,
      total_duration: Number(ended - started)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Ollama->vLLM proxy listening on :${PORT} | keys=${KEYS.length} | rl_mode=${RL_MODE} | max_tokens=${MAX_TOKENS_PER_REQUEST}`);
  console.log(`Models: ${Object.keys(MODEL_MAP).join(', ')}`);
});