/**
 * Latent 生图插件 (rbq-latent-draw)
 * ------------------------------------------------------------
 * 把 latent.moe 的原生异步生图接口接进「RBQ 生图扩展」。
 *
 * 与宿主内置 NAI 模式的差别：
 *   - 宿主 NAI 模式走 NovelAI 协议（同步 + ZIP），只能用到 Latent 的兼容层；
 *   - 本插件走 Latent 原生接口（POST /api/generate → 轮询 → 取私有结果图），
 *     可以把 resolution / steps / sampler / scheduler 这些真实参数交出去，
 *     并且能正确处理 409/429/503 这类真实配额与排队状态。
 *
 * 安装：RBQ 控制台 → 扩展插件 → 安装本文件；刷新页面后「模式」下拉出现 Latent。
 * 配置：模式切到 Latent 后，接口地址填 https://latent.moe ，密钥填 lat_sk_...
 */
(function (RBQ, $, toastr) {
  if (!RBQ || !RBQ.api || typeof RBQ.api.registerMode !== 'function') {
    return console.error('[Latent-Draw] RBQ Core API 缺失，插件未加载');
  }

  const MODE_ID = 'latent';
  const DEFAULT_BASE = 'https://latent.moe';
  const POLL_MS = 2500;
  const DEADLINE_MS = 5 * 60 * 1000;

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('已取消'));
    const t = setTimeout(resolve, ms);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('已取消')); }, { once: true });
    }
  });

  function newIdempotencyKey() {
    try {
      if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* ignore */ }
    return 'rbq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // 允许用户填域名、带 /api 前缀，甚至直接填完整 endpoint，都归一化到站点根
  function normalizeBase(raw) {
    let s = String(raw || '').trim();
    if (!s) return DEFAULT_BASE;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/api\/generate$/i, '');
    s = s.replace(/\/api\/novelai(\/ai\/generate-image)?$/i, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s.replace(/\/+$/, '');
  }

  async function readJson(res) {
    const text = await res.text().catch(() => '');
    try { return text ? JSON.parse(text) : null; } catch (e) { return { __raw: text }; }
  }

  function explain(res, body) {
    const code = res.status;
    const raw = body && (body.error || body.message || body.__raw);
    if (code === 401) return 'Latent 鉴权失败：API Key 无效或已被吊销（应为 lat_sk_ 开头）';
    if (code === 409) return 'Latent 同一账号同时只能跑 1 个任务（too_many_active），请等当前任务完成';
    if (code === 429) return '本周生图额度已用完（quota_exhausted）';
    if (code === 503) {
      const wait = res.headers.get('retry-after');
      return `Latent 队列已满（queue_full）${wait ? '，请 ' + wait + ' 秒后重试' : ''}`;
    }
    if (code === 422) return `参数越界（422）：${typeof raw === 'string' ? raw : JSON.stringify(raw)}`;
    if (code === 202) return '已入队';
    return `Latent 返回 HTTP ${code}${raw ? '：' + (typeof raw === 'string' ? raw : JSON.stringify(raw)) : ''}`;
  }


  /**
   * 采样器/调度器归一化。
   * 面板里允许填 NAI 原生写法（k_euler_ancestral / karras 等），
   * 但 Latent 原生接口只认它自己的三个采样器、四个调度器。
   * 这里做映射，保证「面板选什么」和「发出去什么」一致，不会静默回退。
   */
  const SAMPLER_MAP = {
    euler: 'euler',
    k_euler: 'euler',
    k_euler_ancestral: 'euler',   // Latent 侧无 ancestral 变体，落到 euler
    res_multistep: 'res_multistep',
    er_sde: 'er_sde',
    k_dpmpp_2m: 'res_multistep',
    k_dpmpp_sde: 'er_sde',
  };
  const SCHEDULER_MAP = {
    sgm_uniform: 'sgm_uniform',
    beta: 'beta',
    beta57: 'beta57',
    linear_quadratic: 'linear_quadratic',
    karras: 'sgm_uniform',
    exponential: 'sgm_uniform',   // Latent 侧无 exponential，落到 uniform
    polyexponential: 'sgm_uniform',
    native: 'sgm_uniform',
  };
  function normalizeSampler(v) {
    const k = String(v || '').trim().toLowerCase();
    return SAMPLER_MAP[k] || 'euler';
  }
  function normalizeScheduler(v) {
    const k = String(v || '').trim().toLowerCase();
    return SCHEDULER_MAP[k] || 'sgm_uniform';
  }

  async function generate({ prompt, meta, settings, connection, onProgress, signal }) {
    const apiKey = String((connection && connection.apiKey) || '').trim();
    if (!apiKey) throw new Error('请先填写 Latent API Key（lat_sk_...），可在 https://latent.moe/dashboard/keys 创建');
    if (!String(prompt || '').trim()) throw new Error('提示词为空');

    const base = normalizeBase((connection && connection.url) || DEFAULT_BASE);
    const s = settings || {};
    const body = {
      prompt: String(prompt).trim(),
      resolution: s.latentResolution || 'portrait',
      steps: Number(s.latentSteps) || 8,
      sampler: normalizeSampler(s.latentSampler),
      scheduler: normalizeScheduler(s.latentScheduler),
    };
    const negative = String((meta && meta.negative) || s.negative || '').trim();
    if (negative) body.negativePrompt = negative.slice(0, 2000);
    const seed = Number(s.latentSeed);
    if (Number.isFinite(seed) && seed >= 0) body.seed = Math.floor(seed);

    onProgress && onProgress('正在向 Latent 提交任务...');
    let res = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
        'Idempotency-Key': newIdempotencyKey(),
      },
      body: JSON.stringify(body),
      signal,
    });
    let data = await readJson(res);
    if (res.status !== 202) throw new Error(explain(res, data));

    const jobId = data && data.id;
    if (!jobId) throw new Error('提交成功但没有拿到 job id');
    onProgress && onProgress(`已入队 (${jobId.slice(0, 8)}…)，等待算力...`);

    const deadline = Date.now() + DEADLINE_MS;
    let job = data;
    while (Date.now() < deadline) {
      if (job.status === 'succeeded') break;
      if (job.status === 'failed') throw new Error(`Latent 渲染失败：${job.errorCode || 'unknown'}`);
      if (job.status === 'cancelled') throw new Error('Latent 任务已取消');
      await sleep(POLL_MS, signal);
      const pr = await fetch(`${base}/api/generate/${jobId}`, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal,
      });
      if (pr.status !== 200) throw new Error(explain(pr, await readJson(pr)));
      job = await readJson(pr);
      onProgress && onProgress(
        job.status === 'running'
          ? `渲染中${job.progress != null ? ' ' + job.progress + '%' : ''}`
          : `排队中${job.queuePosition != null ? '（前面 ' + job.queuePosition + '）' : ''}`
      );
    }
    if (job.status !== 'succeeded') throw new Error('等待超时（5 分钟），任务可能仍在后台继续，请稍后在 Latent 的生成记录里查看');
    if (!job.artworkId) throw new Error('渲染完成但没有返回 artworkId');

    onProgress && onProgress('正在下载结果图...');
    const imgRes = await fetch(`${base}/api/media/${job.artworkId}?size=original`, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal,
    });
    if (!imgRes.ok) throw new Error(`下载结果图失败 HTTP ${imgRes.status}`);
    const blob = await imgRes.blob();
    return { blob, meta: { jobId, artworkId: job.artworkId, seed: job.seed, width: job.width, height: job.height } };
  }

  const ok = RBQ.api.registerMode(MODE_ID, {
    title: 'Latent 生图',
    subtitle: 'latent.moe 原生异步接口',
    endpointLabel: 'Latent 地址（默认 https://latent.moe）',
    keyLabel: 'Latent API Key (lat_sk_...)',
    modelLabel: '模型（Latent 侧固定单模型，选哪个都一样）',
    accent: 'custom',
    settingsFields: [
      {
        id: 'rbq-latent-resolution', key: 'latentResolution', label: '分辨率 (resolution)',
        type: 'select', default: 'portrait',
        options: [
          { value: 'portrait', text: '竖图 920×1536' },
          { value: 'square', text: '方图 1024×1024' },
          { value: 'landscape', text: '横图 1536×920' },
        ],
      },
      {
        id: 'rbq-latent-steps', key: 'latentSteps', label: '步数 (steps 8–12)',
        type: 'number', default: 8, min: 8, max: 12, step: 1,
      },
      {
        id: 'rbq-latent-sampler', key: 'latentSampler', label: '采样器 (sampler)',
        type: 'select', default: 'euler',
        options: [
          { value: 'euler', text: 'euler（默认，柔和手绘感）' },
          { value: 'res_multistep', text: 'res_multistep（锐利、细节强）' },
          { value: 'er_sde', text: 'er_sde（带随机性、质感强）' },
          { value: 'k_euler', text: 'k_euler（NAI 写法，自动映射 euler）' },
          { value: 'k_euler_ancestral', text: 'k_euler_ancestral（NAI 写法，自动映射 euler）' },
        ],
      },
      {
        id: 'rbq-latent-scheduler', key: 'latentScheduler', label: '调度器 (scheduler)',
        type: 'select', default: 'sgm_uniform',
        options: [
          { value: 'sgm_uniform', text: 'sgm_uniform（默认，最稳）' },
          { value: 'beta', text: 'beta（细节层次最好）' },
          { value: 'beta57', text: 'beta57（介于 beta 与 uniform 之间）' },
          { value: 'linear_quadratic', text: 'linear_quadratic（大构图/强结构）' },
          { value: 'karras', text: 'karras（NAI 写法，自动映射 sgm_uniform）' },
          { value: 'exponential', text: 'exponential（NAI 写法，自动映射 sgm_uniform）' },
        ],
      },
      {
        id: 'rbq-latent-seed', key: 'latentSeed', label: '种子 (-1 随机)',
        type: 'number', default: -1, min: -1, step: 1,
      },
    ],
  }, generate);


  // ── 参数自检：读「当前真实设置」，算出最终会发给 Latent 的值，并跟最近一条真实记录比对 ──
  async function probeParams() {
    const cfg = (RBQ.api.getSettings && RBQ.api.getSettings()) || {};
    const rawSampler = cfg.latentSampler || 'euler';
    const rawSched = cfg.latentScheduler || 'sgm_uniform';
    const finalSampler = normalizeSampler(rawSampler);
    const finalSched = normalizeScheduler(rawSched);
    const lines = [
      `面板采样器 : ${rawSampler}  → 实际发送 ${finalSampler}`,
      `面板调度器 : ${rawSched}  → 实际发送 ${finalSched}`,
      `分辨率     : ${cfg.latentResolution || 'portrait'}`,
      `步数       : ${cfg.latentSteps || 8}`,
      `种子       : ${Number(cfg.latentSeed) >= 0 ? cfg.latentSeed : '随机'}`,
    ];
    if (rawSampler.toLowerCase() !== finalSampler) lines.push(`⚠ 采样器被映射：${rawSampler} Latent 不支持，已换成 ${finalSampler}`);
    if (rawSched.toLowerCase() !== finalSched) lines.push(`⚠ 调度器被映射：${rawSched} Latent 不支持，已换成 ${finalSched}`);
    lines.push('');
    lines.push('—— 服务端最近一条记录（用来核对是否真的生效）——');
    try {
      const base = normalizeBase(cfg.latentUrl || cfg.url || DEFAULT_BASE);
      const key = String(cfg.latentApiKey || cfg.apiKey || '').trim();
      if (!key) throw new Error('未填写 API Key');
      const res = await fetch(base + '/api/generate', { headers: { Authorization: 'Bearer ' + key } });
      const data = await readJson(res);
      const last = data && Array.isArray(data.jobs) && data.jobs[0];
      if (!last) lines.push('（还没有生成记录）');
      else lines.push(`最近一条 : sampler=${last.sampler} scheduler=${last.scheduler} steps=${last.steps}`);
      if (last && last.scheduler === finalSched) lines.push('✅ 调度器与服务端记录一致，说明真的生效');
      else if (last) lines.push(`❌ 不一致：你要 ${finalSched}，服务端是 ${last.scheduler}`);
    } catch (e) {
      lines.push('读取记录失败：' + (e.message || e));
    }
    return lines.join('\n');
  }

  // 注册到「生成测试」面板，作为一个按钮
  try {
    if (RBQ.ui && typeof RBQ.ui.registerTestAction === 'function') {
      RBQ.ui.registerTestAction({
        id: 'rbq-latent-probe',
        label: '参数自检',
        icon: 'fa-solid fa-stethoscope',
        priority: 5,
        style: 'background: rgba(120,200,255,0.15); border: 1px solid rgba(120,200,255,0.35); font-weight: 600;',
        onClick: async ({ setResult, setLoading, toastr }) => {
          try {
            setLoading && setLoading(true, '检查中...');
            const text = await probeParams();
            setResult && setResult(`<pre style="text-align:left; white-space:pre-wrap; font-size:13px; line-height:1.6; margin:8px;">${text}</pre>`);
          } catch (e) {
            toastr && toastr.error && toastr.error(e.message || String(e));
          } finally {
            setLoading && setLoading(false);
          }
        },
      });
    }
  } catch (e) { console.warn('[Latent-Draw] 注册自检按钮失败', e); }

  if (ok) console.info('[Latent-Draw] 已注册生图模式: ' + MODE_ID);

  // 宿主在非 comfyui/nai 模式下会去请求 `${url}/models` 拉模型列表，
  // Latent 没有这个端点，下拉会是空的；而核心的 generateImage 又要求 model 非空，
  // 所以这里主动塞一个占位模型（与官方 grok-draw 插件同样的做法）。
  const MODEL_ID = 'latent-default';
  function syncModelOption() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    const modeSelect = document.getElementById('st-scene-trigger-current-mode');
    const modelSelect = document.getElementById('st-scene-trigger-modal-model');
    if (!modeSelect || !modelSelect) return;
    if (modeSelect.value !== MODE_ID) return;
    if (modelSelect.querySelector('option[data-source="latent"]')) return;
    modelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = MODEL_ID;
    opt.textContent = 'Latent（服务端单模型，无需选择）';
    opt.setAttribute('data-source', 'latent');
    modelSelect.appendChild(opt);
    modelSelect.value = MODEL_ID;
  }
  const modelTimer = setInterval(syncModelOption, 1000);

  // 宿主卸载/热更新插件时会回调这个清理钩子，别把定时器留在页面上
  if (typeof RBQ.registerCleanup === 'function') {
    RBQ.registerCleanup('rbq-latent-draw', () => {
      clearInterval(modelTimer);
      if (typeof RBQ.api.unregisterMode === 'function') RBQ.api.unregisterMode(MODE_ID);
      try { RBQ.ui && RBQ.ui.unregisterTestAction && RBQ.ui.unregisterTestAction('rbq-latent-probe'); } catch (e) {}
      console.info('[Latent-Draw] 已清理');
    });
  }})(window.RBQ, window.jQuery, window.toastr);
